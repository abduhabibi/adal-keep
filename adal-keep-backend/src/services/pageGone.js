/**
 * pageGone.js — a check's own tab is gone (closed, crashed, replaced) and every next step would fail the same way
 * (2026-11-26, Main: the contracts check failed on every girl with "Attempted to use detached Frame 'F0FE…'", the same
 * frame each time). Said once, with what closed it when known (page.__adalClosedBy); the check stops at once.
 * Pure but for reading the page object; never throws. Off: ADAL_PAGE_GONE=0 (every error counted for its girl).
 */
const LOST = /detached Frame|Target closed|Session closed|Protocol error.*(closed|Target)|No target with given id|Execution context was destroyed.*navigat/i

export const pageGoneOn = (env = process.env) => env.ADAL_PAGE_GONE !== '0'

function detached(page) {
  try { const f = page.mainFrame?.(); return !!(f && (f.detached ?? f.isDetached?.())) } catch { return true }
}

/** Why the tab is gone ('' while it is there). `e`: the error a step just gave, if any. */
export function pageGone(page, e = null) {
  if (!pageGoneOn() || !page) return ''
  let closed = false
  try { closed = !!page.isClosed?.() } catch { closed = true }
  const lost = closed || !!page.__adalCrashed || detached(page) || (e != null && LOST.test(String(e?.message || e)))
  if (!lost) return ''
  const by = page.__adalClosedBy ? `closed by ${page.__adalClosedBy}` : page.__adalCrashed ? 'its page crashed' : closed ? 'closed' : 'its page was replaced or closed'
  return `its tab is gone (${by})`
}

/** Marks who closes a tab, for the line above. */
export function closedBy(page, who) { try { if (page && !page.__adalClosedBy) page.__adalClosedBy = who } catch {} }
