/**
 * liveHands.js — a person's clicks, wheel and keys in the live view go first (2026-11-25, Main at 100 %: every click
 * waited behind screenshots and questions to the page and was given up after 8 s).
 *
 *  - Each is given to the browser at once, in order, and nothing is asked of the page before (its size is known from
 *    the pictures). The browser keeps it until the page can take it: it is never dropped for being slow.
 *  - The answer says what happened: sent; taken (the page has handled it, and after how many ms) or not yet.
 *  - While one is on its way no screenshot of the page is asked for (liveFrames.js).
 *  - A mouse that only moves over a slow page is not piled up: its newest place counts.
 * ADAL_LIVE_HANDS=0: as before.
 */
export const handsOn = () => process.env.ADAL_LIVE_HANDS !== '0'
const BUTTONS = ['left', 'middle', 'right']
const MODS = { alt: 1, ctrl: 2, meta: 4, shift: 8 }
const modsOf = (b) => Object.entries(MODS).reduce((m, [k, v]) => m | (b[k] ? v : 0), 0)
const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0))
const wait = (p, ms, d) => { let t; return Promise.race([p, new Promise(r => { t = setTimeout(() => r(d), ms) })]).finally(() => clearTimeout(t)) }

const st = new WeakMap()                 // page → { cdp, pending, moves }
const of = (page) => { let s = st.get(page); if (!s) st.set(page, s = { cdp: null, pending: 0, moving: null, next: null, chain: Promise.resolve() }); return s }
/** A person's click or key is on its way to this page now. */
export const handsBusy = (page) => (st.get(page)?.pending || 0) > 0

async function sizeOf(page) {
  if (page.__adalFrameSize) return page.__adalFrameSize           // from the newest picture
  if (page.__adalSize) return page.__adalSize
  const v = page.viewport?.()
  const asked = await wait(page.evaluate(() => [innerWidth, innerHeight]).catch(() => null), 400, null)
  if (asked) return (page.__adalSize = { w: asked[0], h: asked[1], at: Date.now() })
  return v ? { w: v.width, h: v.height } : { w: 1366, h: 900 }    // a run's tab (tabManager.setupTab)
}

/** Can this one go straight to the browser? */
export const direct = (b) => ['mouse', 'wheel', 'paste', 'click'].includes(b?.kind)

/** Sends it now. → { ack: Promise } resolved when the page took it. */
async function sendNow(page, b) {
  const s = of(page)
  s.cdp ||= page.createCDPSession().catch(e => { s.cdp = null; throw e })
  const cdp = await s.cdp
  const track = (p) => { s.pending++; const t0 = Date.now(); return p.then(() => Date.now() - t0).finally(() => { s.pending-- }) }
  const go = (m, a) => track(cdp.send(m, a))
  if (b.kind === 'paste') return { ack: go('Input.insertText', { text: String(b.text || '').slice(0, 20000) }) }
  const { w, h } = await sizeOf(page)
  const x = clamp(b.x, 0, 1) * w, y = clamp(b.y, 0, 1) * h, modifiers = modsOf(b)
  if (b.kind === 'wheel') return { ack: go('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: clamp(b.dx, -3000, 3000), deltaY: clamp(b.dy, -3000, 3000), modifiers }) }
  if (b.kind === 'click') {
    const at = { x, y, button: 'left', clickCount: 1, modifiers }
    go('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers }).catch(() => {})
    go('Input.dispatchMouseEvent', { type: 'mousePressed', ...at, buttons: 1 }).catch(() => {})
    return { ack: go('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at, buttons: 0 }) }
  }
  const type = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' }[b.type]
  if (!type) throw Object.assign(new Error('Unknown mouse input'), { status: 400 })
  const a = { type, x, y, button: b.type === 'move' ? (b.buttons ? 'left' : 'none') : (BUTTONS[Number(b.button) || 0] || 'left'), buttons: Number(b.buttons) || 0, clickCount: b.type === 'move' ? 0 : clamp(b.clickCount || 1, 1, 3), modifiers }
  if (b.type !== 'move') {
    // Where the mouse is now goes before the press (a move still waiting for a slow page).
    if (s.next) { const n = s.next; s.next = null; go('Input.dispatchMouseEvent', n).catch(() => {}) }
    return { ack: go('Input.dispatchMouseEvent', a) }
  }
  if (s.moving) { s.next = a; return { ack: Promise.resolve(0) } }
  const one = (m) => { s.moving = cdp.send('Input.dispatchMouseEvent', m).catch(() => {}).then(() => { s.moving = null; if (s.next) { const n = s.next; s.next = null; one(n) } }) }
  one(a)
  return { ack: Promise.resolve(0) }
}

/**
 * A burst of inputs, in order. other(b): does one that is not a mouse's (keys, typing, navigation), as before.
 * → { sent, taken: ms | null, error } — taken: the last one's, when the page took it within waitMs.
 */
export function hands(page, list, { other, waitMs = 1200, log = () => {} } = {}) {
  const s = of(page)
  const run = async () => {
    let last = null, sent = 0, code = null, error = null
    for (const b of list) {
      const t0 = Date.now()
      try {
        if (direct(b)) {
          const { ack } = await wait(sendNow(page, b), 4000, null) || (() => { throw new Error('The robot browser does not take input just now.') })()
          ack.catch(() => {})
          sent++
          if (!(b.kind === 'mouse' && b.type === 'move')) { last = ack; ack.then((ms) => log(b, ms), (e) => log(b, Date.now() - t0, e)) }
        } else {
          s.pending++
          const p = Promise.resolve(other(b)).finally(() => { s.pending-- })
          p.then(() => log(b, Date.now() - t0), (e) => log(b, Date.now() - t0, e))
          const long = ['nav', 'reload', 'back', 'forward', 'code'].includes(b.kind)
          const r = await wait(p, long ? 50000 : 3000, undefined)   // (not over in 3 s: it goes on, the next one after it)
          sent++; last = p.then(() => Date.now() - t0); last.catch(() => {})
          if (r) code = r
        }
      } catch (e) { error = e; log(b, Date.now() - t0, e) }
    }
    return { last, sent, code, error }
  }
  const done = s.chain.then(run, run)
  s.chain = done.catch(() => {})
  return done.then(async ({ last, sent, code, error }) => {
    const taken = last ? await wait(last.catch(() => null), waitMs, null) : 0
    if (error && !sent) throw error
    return { sent, taken, code, error }
  })
}
