/**
 * What a person sees of a run's tab, as it changes: Chromium sends a picture the
 * moment the page changes (a screenshot on request takes far longer, and made the
 * live view run a second or more behind). A page that stands still sends nothing,
 * and a tab Chromium stops drawing sends nothing either, so a screenshot fills in.
 */
const FILL_IN_MS = 1500
const IDLE_MS = 6000
const casts = new Map()   // page → its stream

async function shot(page) {
  return Buffer.from(await page.screenshot({ type: 'jpeg', quality: 60, captureBeyondViewport: false }))
}

async function castOf(page) {
  if (casts.has(page)) return casts.get(page)
  const c = { subs: new Set(), last: null, at: 0, used: Date.now(), cdp: null, ready: null, timer: null, filling: false }
  casts.set(page, c)
  const give = (buf) => {
    if (c.last?.equals(buf)) return
    c.last = buf
    for (const fn of c.subs) fn(buf)
  }
  c.ready = (async () => {
    c.cdp = await page.createCDPSession()
    c.cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      c.at = Date.now()
      give(Buffer.from(data, 'base64'))
      c.cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    })
    // Chromium slows a tab nobody is looking at; while a person watches, it counts as looked at.
    await c.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
    await c.cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
    await c.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1366, maxHeight: 900, everyNthFrame: 1 })
  })().catch(() => {})
  c.timer = setInterval(async () => {
    if (!c.subs.size && Date.now() - c.used > IDLE_MS) return stop(page, c)
    if (c.filling || Date.now() - c.at < FILL_IN_MS) return
    c.filling = true
    try { give(await shot(page)) } catch {} finally { c.filling = false }
  }, 500)
  c.timer.unref?.()
  page.once('close', () => stop(page, c))
  await c.ready
  return c
}

function stop(page, c) {
  casts.delete(page)
  clearInterval(c.timer)
  c.cdp?.send('Page.stopScreencast').catch(() => {}).finally(() => c.cdp?.detach().catch(() => {}))
}

/** Calls onFrame(jpeg) with each new picture. Returns what stops it. */
export async function watchFrames(page, onFrame) {
  const c = await castOf(page)
  c.subs.add(onFrame)
  if (c.last) onFrame(c.last)
  else shot(page).then(b => { if (!c.last) { c.last = b; onFrame(b) } }).catch(() => {})
  return () => { c.subs.delete(onFrame); c.used = Date.now() }
}

/** The newest picture of the tab, for whoever asks now and then. */
export async function latestFrame(page) {
  const c = await castOf(page)
  c.used = Date.now()
  return c.last || (c.last = await shot(page))
}
