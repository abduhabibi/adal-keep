/**
 * What a person sees of a run's tab, as it changes: Chromium sends a picture the
 * moment the page changes (a screenshot on request takes far longer, and made the
 * live view run a second or more behind). A page that stands still sends nothing,
 * and a tab Chromium stops drawing sends nothing either, so a screenshot fills in.
 */
// A picture by request only when Chromium sent none: 0.7 s while nothing came yet. Then a still page costs nothing
// (a whole picture asked for every second took 2.4 s each on a 2-core PC, 2026-11-25): it is looked at every 5 s,
// and only a tab that changed without Chromium saying so (it stopped drawing it) is asked every second again.
const FILL_IN_MS = 700
const STILL_MS = 5000
const BLIND_MS = 1000
const IDLE_MS = 6000
// Small pictures: a weak PC encodes them faster and a slow line carries them (text stays readable).
const QUALITY = 50, MAX_W = 1280, MAX_H = 840
const casts = new Map()   // page → its stream
const kept = new WeakMap()   // page → its last picture (shown at once when a person looks again)

/** What this tab looked like last, or null. */
export const lastPicture = (page) => casts.get(page)?.last || kept.get(page) || null

async function shot(page) {
  return Buffer.from(await page.screenshot({ type: 'jpeg', quality: QUALITY, captureBeyondViewport: false }))
}

const ACK_MS = 200, ACK_UNSEEN_MS = 500   // between a picture and the next
/** Somebody sees this tab now (robotGuard leaves it at full speed). */
export const isWatched = (page) => (casts.get(page)?.subs.size || 0) > 0

async function castOf(page) {
  try { await page.__adalWake?.() } catch {}   // slowed by robotGuard: full speed for the person
  try { await page.__adalRestWake?.() } catch {}   // it rested while nobody looked (restPage.js)
  if (casts.has(page)) return casts.get(page)
  const c = { subs: new Set(), ends: new Set(), dead: false, last: null, at: Date.now(), used: Date.now(), cdp: null, ready: null, timer: null, filling: false }
  casts.set(page, c)
  const give = (buf) => {
    if (c.last?.equals(buf)) return
    c.last = buf
    kept.set(page, buf)
    for (const fn of c.subs) fn(buf)
  }
  c.ready = (async () => {
    c.cdp = await page.createCDPSession()
    c.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      c.at = Date.now()
      c.blind = false; c.shot = null
      give(Buffer.from(data, 'base64'))
      // The next picture is made only after this: a page that never stands still (a spinner, an animation) drew and
      // sent up to 60 pictures a second — a whole core while someone watched.
      setTimeout(() => c.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {}), c.subs.size ? ACK_MS : ACK_UNSEEN_MS).unref?.()
    })
    // Chromium slows a tab nobody is looking at; while a person watches, it counts as looked at.
    await c.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await c.cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
    await c.cdp.send('Page.startScreencast', { format: 'jpeg', quality: QUALITY, maxWidth: MAX_W, maxHeight: MAX_H, everyNthFrame: 1 })
  })().catch(() => { c.dead = true })
  c.timer = setInterval(async () => {
    if (!c.subs.size && Date.now() - c.used > IDLE_MS) return stop(page, c)
    if (c.filling || Date.now() - c.at < (!c.last ? FILL_IN_MS : c.blind ? BLIND_MS : STILL_MS)) return
    c.filling = true
    try {
      const b = await shot(page)
      // The picture before (asked for, not Chromium's own: those are cut smaller) was another: it changed unseen.
      if (c.shot && !c.shot.equals(b)) c.blind = true
      if (!c.last || c.blind) give(b)
      c.shot = b; c.fails = 0; c.at = Date.now()
    } catch { c.fails = (c.fails || 0) + 1; if (c.fails >= 3 && Date.now() - c.at > 3 * FILL_IN_MS) stop(page, c) } finally { c.filling = false }
  }, 250)
  c.timer.unref?.()
  page.once('close', () => stop(page, c))
  await c.ready
  if (c.dead) { stop(page, c); throw new Error('This tab cannot be shown.') }
  return c
}

function stop(page, c) {
  if (casts.get(page) === c) casts.delete(page)
  clearInterval(c.timer)
  for (const fn of c.ends) { try { fn() } catch {} }
  c.ends.clear()
  c.cdp?.send('Page.stopScreencast').catch(() => {}).finally(() => c.cdp?.detach().catch(() => {}))
}

/** Calls onFrame(jpeg) with each new picture (onEnd when the tab goes). Returns what stops it. Throws when the tab cannot be shown. */
export async function watchFrames(page, onFrame, onEnd) {
  const c = await castOf(page)
  c.subs.add(onFrame)
  if (onEnd) c.ends.add(onEnd)
  if (c.last) onFrame(c.last)
  return () => { c.subs.delete(onFrame); c.ends.delete(onEnd); c.used = Date.now() }
}

/** The newest picture of the tab, for whoever asks now and then. */
export async function latestFrame(page) {
  const c = await castOf(page)
  c.used = Date.now()
  // Chromium's first picture comes in some 50 ms; asked for only when it does not.
  for (let i = 0; i < 20 && !c.last; i++) await new Promise(r => setTimeout(r, 35))
  return c.last || (c.last = await shot(page))
}
