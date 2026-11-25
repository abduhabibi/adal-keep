/**
 * restPage.js — a page that waits for a person ("I'm not a robot") while nobody looks costs next to nothing: after
 * 20 s without a look its moving pictures stand still, and (where its tab is behind another) it counts as a page
 * nobody sees — no drawing, its timers once a second. The run asks it once a second and not three times.
 * The moment a person opens the live view (liveFrames.castOf), the tick comes or the run goes on: as before.
 * Nothing of it when the robot browser has a window of its own on the screen. ADAL_REST=0 turns it off; any error:
 * the page stays awake.
 */
export const REST_AFTER_MS = 20000
export const REST_POLL_MS = 1200
const within = (p, ms) => { let t; return Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => { t = setTimeout(() => r(null), ms) })]).finally(() => clearTimeout(t)) }
const shown = (page) => !!(page.__adalPerson || page.__adalShown || (process.env.ADAL_ROBOT_PROCESS === '1' && process.env.ADAL_ROBOTS_WINDOW === '1'))

/** → { pause(ms): waits ms (longer while resting, over at once when woken), end(): awake again } */
export function rester(page, { afterMs = REST_AFTER_MS, pollMs = REST_POLL_MS, watched = () => false, off = process.env.ADAL_REST === '0' } = {}) {
  let resting = false, wakeUp = null, since = Date.now(), ended = false
  const cdp = () => page.__adalCdp
  const set = async (on) => {
    const s = cdp()
    if (!s) return
    await within(Promise.all([
      s.send('Emulation.setFocusEmulationEnabled', { enabled: !on }),
      s.send('Animation.enable').then(() => s.send('Animation.setPlaybackRate', { playbackRate: on ? 0 : 1 })),
    ]), 3000)
    if (!on) await within(s.send('Animation.disable'), 1500)
  }
  const wake = async () => {
    since = Date.now()
    if (!resting) return
    resting = false
    page.__adalRestWake = null
    wakeUp?.()
    await set(false)
  }
  const quietSince = () => Math.max(since, page.__adalLookedAt || 0, page.__adalInputAt || 0)
  return {
    get resting() { return resting },
    wake: () => wake().catch(() => {}),
    async pause(ms) {
      try {
        const may = !off && !ended && cdp() && !shown(page) && !watched(page) && Date.now() - quietSince() > afterMs
        if (resting && !may) await wake()
        else if (may && !resting) { resting = true; page.__adalRestWake = wake; await set(true) }
      } catch {}
      let t
      await new Promise(r => { wakeUp = r; t = setTimeout(r, resting ? Math.max(ms, pollMs) : ms) })
      clearTimeout(t); wakeUp = null
    },
    async end() { ended = true; await wake().catch(() => {}) },
  }
}
