/**
 * liveClicks.js — what became of a click in the live view, for the ring drawn where it was pressed (LiveCanvas):
 * 'sent' at once, 'taken' when the page has it, 'waiting' while a slow page has not (it is kept, never lost), 'failed'.
 */
const subs = new Map()                    // run id → Set(fn)
export function onClicks(runId, fn) {
  const k = String(runId)
  if (!subs.has(k)) subs.set(k, new Set())
  subs.get(k).add(fn)
  return () => { subs.get(k)?.delete(fn); if (!subs.get(k)?.size) subs.delete(k) }
}
export const clickIs = (runId, state) => { for (const fn of subs.get(String(runId)) || []) { try { fn(state) } catch {} } }
/** The answer of POST /automations/:id/input → the ring's state ('' = an older PC: it only says ok). */
export const stateOf = (data) => (data?.error ? 'failed' : data?.taken === undefined ? 'taken' : data.taken === null ? 'waiting' : 'taken')
export const isClick = (b) => b?.kind === 'click' || (b?.kind === 'mouse' && b.type === 'up')
