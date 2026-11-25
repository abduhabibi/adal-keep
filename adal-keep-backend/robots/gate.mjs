/**
 * gate.mjs — does the next run start now on this PC? (Adal Robots, services/worker.js setClaimGate)
 *
 * While a run of ours works and the processor is over the limit, the next one waits: two at once would be slower.
 * But the rest of the PC being busy is not a reason to never start (2026-11-25: a 2-core main PC at 93–100 %, runs
 * waited for ever and the log said so every 10 s), and a run that waits for a person is not work: with none of ours
 * working it starts after at most maxWaitMs.
 * "Busy" is the average of the last 15 s (averageLoad): one look of a second flipped every 5–10 s on a 2-core PC whose
 * average was about 5 %. A run a person just pressed does not wait here.
 * ADAL_ROBOTS_CPU (0.8) the limit, ADAL_ROBOTS_GATE_S (20) the longest wait; ADAL_ROBOTS_GATE=0: no gate.
 */
export function makeGate({ busy, working, say = () => {}, maxWaitMs = (Number(process.env.ADAL_ROBOTS_GATE_S) || 20) * 1000, limit = 0.8, now = Date.now, pressed = async () => false, waiting = async () => true }) {
  let since = 0, told = false
  return async () => {
    if (process.env.ADAL_ROBOTS_GATE === '0') return true
    // No run waits: nothing to hold and nothing to say (2026-11-25: "the run starts anyway" 22 times with none in line).
    if (!(await Promise.resolve(waiting()).catch(() => true))) { since = 0; told = false; return true }
    const hot = await busy()
    // A run a person pressed starts now, whatever else this PC does.
    if (hot && await Promise.resolve(pressed()).catch(() => false)) return true
    const t = now()
    if (!hot) {
      if (told) say(`the processor is free again after ${Math.round((t - since) / 1000)} s`)
      since = 0; told = false
      return true
    }
    if (!since) since = t
    const ours = working()
    if (!ours && t - since >= maxWaitMs) {
      say(`the processor is over ${Math.round(limit * 100)} % busy with other programs — the run starts anyway (none of ours works, it waited ${Math.round((t - since) / 1000)} s)`)
      since = t; told = false            // (the one after it waits its own turn)
      return true
    }
    if (!told) { told = true; say(`the processor is over ${Math.round(limit * 100)} % busy${ours ? ' and a run works' : ''} — the next run waits${ours ? ' for it' : ` at most ${Math.round(maxWaitMs / 1000)} s`}`) }
    return false
  }
}

/** The processor's busy share over the last `span` ms, from samples every `every` ms (costs nothing). → { over(limit), value(), stop() } */
export function averageLoad({ times, span = 15000, every = 2500, now = Date.now, timer = true } = {}) {
  let seen = []
  const take = () => { try { seen.push({ at: now(), ...times() }) } catch {} ; seen = seen.filter(s => now() - s.at <= span + every) }
  take()
  const t = timer ? setInterval(take, every) : null
  t?.unref?.()
  const value = () => {
    const a = seen[0], b = seen[seen.length - 1]
    return !a || !b || b.at - a.at < span / 2 || b.all <= a.all ? 0 : 1 - (b.idle - a.idle) / (b.all - a.all)
  }
  return { take, value, over: (limit) => value() > limit, stop: () => clearInterval(t) }
}
