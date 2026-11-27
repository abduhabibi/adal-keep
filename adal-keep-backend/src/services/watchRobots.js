/**
 * "Watch robots" (the owner, 2026-11-27, option 5): one click brings the robots' Adal Browser
 * window on screen as one normal window, its site tabs working live; a second click sends it
 * back out of sight. The same browser all along: nothing restarts, every sign-in stays.
 *
 * - Only on a person's click: nothing here runs by itself, and it never starts the browser
 *   (no robot working → "Nothing to watch").
 * - While watched, the window is still the agents' window: a run's tab is told apart as
 *   before (browser.js outOfSight says "out of sight"), so one tab a site goes on and no
 *   run opens a second one; nothing sends the window away meanwhile (browser.js hide).
 * - A restarted browser is not watched (its windows start out of sight).
 * - Linux: headless, no window to show (the live view shows the tabs).
 * Off: ADAL_WATCH_ROBOTS=0 (no button, the route says off).
 */
import { noWindows } from './noWindows.js'

export const watchOn = () => process.env.ADAL_WATCH_ROBOTS !== '0'

// { browser, moved: Set<windowId>, seen: Set<windowId> } while watched.
let state = null
const alive = (b) => !!b && (typeof b.isConnected === 'function' ? b.isConnected() : b.connected === true)

/** True while a person watches the robots' window (browser.js asks before hiding a window). */
export function watchingNow() {
  if (!state) return false
  if (!alive(state.browser)) { state = null; return false }
  return true
}

/** This window is one the person brought on screen to watch. */
export const watchedWindow = (id) => watchingNow() && state.moved.has(id)

const offScreen = (b) => b?.windowState === 'minimized' || (b?.left ?? 0) < -10000

/** The robots' windows: [{ windowId, bounds, targets: [{ targetId, url }] }]. */
async function windowsOf(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets')
  const byWin = new Map()
  for (const t of targetInfos) {
    if (t.type !== 'page') continue
    const w = await cdp.send('Browser.getWindowForTarget', { targetId: t.targetId }).catch(() => null)
    if (!w) continue
    if (!byWin.has(w.windowId)) byWin.set(w.windowId, { windowId: w.windowId, bounds: w.bounds, targets: [] })
    byWin.get(w.windowId).targets.push({ targetId: t.targetId, url: t.url })
  }
  return [...byWin.values()]
}

const shown = (w) => w.targets.filter(t => !/^about:blank|^chrome|^devtools/.test(t.url)).length

/** What the button shows. */
export async function watchState() {
  if (!watchOn()) return { on: false, why: 'off' }
  if (noWindows()) return { on: true, watching: false, can: false, why: 'This PC shows the robots in the live view only (no window here).' }
  return { on: true, watching: watchingNow(), can: true }
}

/** Show (true) or send away (false) the robots' window. */
export async function setWatch(show) {
  if (!watchOn()) return { on: false, why: 'off' }
  if (noWindows()) return { on: true, watching: false, can: false, why: 'This PC shows the robots in the live view only (no window here).' }
  const { openBrowserIfAny, OFF_BOUNDS } = await import('./browser.js')
  const browser = await openBrowserIfAny()   // never starts it
  if (!browser) { state = null; return { on: true, watching: false, can: true, why: 'Nothing to watch: no robot browser is open now.' } }
  const cdp = await browser.target().createCDPSession()
  try {
    const wins = await windowsOf(cdp)
    if (show) {
      const moved = new Set(state?.browser === browser ? state.moved : [])
      // Out of sight now: these are the robots'. A window already on screen (a person's) is left as it is.
      const mine = wins.filter(w => offScreen(w.bounds))
      // The busiest window last, so it ends up in front.
      mine.sort((a, b) => shown(a) - shown(b))
      for (const w of mine) {
        await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } }).catch(() => {})
        await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { left: 40, top: 20, width: OFF_BOUNDS.width, height: OFF_BOUNDS.height } }).catch(() => {})
        await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'maximized' } }).catch(() => {})
        moved.add(w.windowId)
      }
      const seen = new Set([...(state?.browser === browser ? state.seen : []), ...wins.map(w => w.windowId)])
      state = { browser, moved, seen }
      // Its working tab in front (a site's, not the empty anchor tab).
      const top = mine[mine.length - 1]
      const tab = top?.targets.find(t => !/^about:blank/.test(t.url)) || top?.targets[0]
      if (tab) await cdp.send('Target.activateTarget', { targetId: tab.targetId }).catch(() => {})
      return { on: true, watching: true, can: true, windows: mine.length, tabs: mine.reduce((n, w) => n + shown(w), 0) }
    }
    // Back out of sight: the windows this moved, and any opened meanwhile (a site's pop-up from a run's tab).
    const moved = state?.browser === browser ? state.moved : new Set()
    const seen = state?.browser === browser ? state.seen : null
    state = null
    let n = 0
    for (const w of wins) {
      if (offScreen(w.bounds) || !(moved.has(w.windowId) || (seen && !seen.has(w.windowId)))) continue
      await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: { windowState: 'normal' } }).catch(() => {})
      await cdp.send('Browser.setWindowBounds', { windowId: w.windowId, bounds: OFF_BOUNDS }).catch(() => {})
      n++
    }
    return { on: true, watching: false, can: true, windows: n }
  } finally { cdp.detach().catch(() => {}) }
}

export const _reset = () => { state = null }
