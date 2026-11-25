/**
 * gate.mjs — does the next run start now on this PC? (Adal Robots, services/worker.js setClaimGate)
 *
 * While a run of ours works and the processor is over the limit, the next one waits: two at once would be slower.
 * But the rest of the PC being busy is not a reason to never start (2026-11-25: a 2-core main PC at 93–100 %, runs
 * waited for ever and the log said so every 10 s), and a run that waits for a person is not work: with none of ours
 * working it starts after at most maxWaitMs.
 * ADAL_ROBOTS_CPU (0.8) the limit, ADAL_ROBOTS_GATE_S (20) the longest wait; ADAL_ROBOTS_GATE=0: no gate.
 */
export function makeGate({ busy, working, say = () => {}, maxWaitMs = (Number(process.env.ADAL_ROBOTS_GATE_S) || 20) * 1000, limit = 0.8, now = Date.now }) {
  let since = 0, told = false
  return async () => {
    if (process.env.ADAL_ROBOTS_GATE === '0') return true
    const hot = await busy()
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
