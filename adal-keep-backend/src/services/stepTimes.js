/**
 * stepTimes.js — how long each robot step takes, one log line per step (2026-11-27).
 *
 * Main's robots.log had no step times, so the slowest steps could not be ranked from it. A step wrapped with timed()
 * writes `[steps] run=<id> profile=<profile id> <site> <step> <seconds> s` to robots.log when it ends — also when it
 * throws (then `... failed`). Log only: the step runs exactly as before, its result or error passes through, and
 * nothing but the profile id is written (no name, no passport). scripts/step-times.mjs ranks the lines.
 * ADAL_STEP_TIMES=0 turns the lines off (the wrapper then calls the step directly).
 */
export const stepTimesOn = () => process.env.ADAL_STEP_TIMES !== '0'

export function timed(site, name, fn) {
  const wrapped = async function (...args) {
    if (!stepTimesOn()) return fn.apply(this, args)
    const t0 = Date.now()
    const say = (tail) => {
      try {
        const c = args[1] || {}
        console.log(`[steps] run=${c.runId ?? ''} profile=${c.profileId ?? ''} ${site} ${name} ${((Date.now() - t0) / 1000).toFixed(1)} s${tail}`)
      } catch {}
    }
    try { const r = await fn.apply(this, args); say(''); return r }
    catch (e) { say(' failed'); throw e }
  }
  Object.defineProperty(wrapped, 'name', { value: name })
  return wrapped
}
