/**
 * replicaThrottle.js — a Companion's copy of the agency must never swamp the main PC
 * (2026-11-22: a Companion started its copy over the office network on a weak main PC that was
 * already at 100%, the main PC's answers went from 0.1 s to timeouts and the PC dropped off the
 * network). The copy is the least urgent work there is:
 *   - one transfer at a time (a queue, first come first served), whatever the number of Companions;
 *   - while this PC is busy (processor over 85 %) a transfer waits, up to 20 s, then goes ahead slowly;
 *   - a short rest after each piece, longer while busy, so robots and people get the processor between pieces;
 *   - a queue that does not move in 30 s answers "busy, try again" (503 + Retry-After): the Companion asks again.
 * Compression and reading are asynchronous (replica.js dbChunkAsync), never blocking the event loop.
 */
const MAX_QUEUE_WAIT_MS = 30_000
const BUSY_LOAD = 85
let active = false
const queue = []

const sleep = (ms) => new Promise(r => { const t = setTimeout(r, ms); t.unref?.() })
const ownLoad = async () => { try { return (await import('./sharePower.js')).ownPower().load ?? 0 } catch { return 0 } }

/** Runs fn when it is this transfer's turn. Rejects { status: 503 } when the queue does not move. */
export async function withSlot(fn, { load = ownLoad, restMs = 40, busyRestMs = 400, waitBusyMs = 20_000, queueMs = MAX_QUEUE_WAIT_MS } = {}) {
  if (active) {
    await new Promise((resolve, reject) => {
      const w = { resolve }
      w.timer = setTimeout(() => { const i = queue.indexOf(w); if (i >= 0) queue.splice(i, 1); reject(Object.assign(new Error('The main PC is busy copying: try again in a moment'), { status: 503, retryAfter: 5 })) }, queueMs)
      w.timer.unref?.()
      queue.push(w)
    })
  }
  active = true   // (a waiter is handed the slot as it is released: nobody else takes it in between)
  let busy = false
  try {
    for (let waited = 0; (await load()) > BUSY_LOAD && waited < waitBusyMs; waited += 2000) { busy = true; await sleep(2000) }
    return await fn()
  } finally {
    await sleep(busy ? busyRestMs : restMs)
    const next = queue.shift()
    if (next) { clearTimeout(next.timer); next.resolve() } else active = false
  }
}
export const _queueLength = () => queue.length
