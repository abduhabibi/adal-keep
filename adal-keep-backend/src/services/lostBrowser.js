/**
 * lostBrowser.js — the robot browser (or the run's tab) was lost while a run worked: closed, crashed, killed, or its
 * page stopped answering (deadTabs.js). When nothing had been sent to the site yet, the run goes back in line, once —
 * it is not "failed" (2026-11-25, Main: "Requesting main frame too early!"). When something may have been sent, it is
 * never done again by itself. "Sent": any request of the run's tab that is not a reading (POST, PUT …) outside the
 * sign-in pages, counted from the run's start (tabManager.setupTab). In doubt it counts as sent.
 * ADAL_LOST_BACK=0: every lost run fails, as before.
 */
const LOST = /Requesting main frame too early|Target closed|Session closed|Connection closed|Protocol error.*(closed|detached)|detached Frame|frame was detached|Browser (has )?disconnected|WebSocket is not open|Execution context was destroyed.*closed|No browser|Page has been closed|page\.\w+: Target/i
const SIGN_IN = /(^|\.)wahid\.sa$|(^|\.)(google\.com|gstatic\.com|recaptcha\.net)$/i
const SIGN_IN_PATH = /\/(login|auth|signin|sign-in|otp|token|openid-connect|account\/login)\b/i

/** A request of a run's tab: noted when it changes something on the site. */
export function noteSent(page, req) {
  try {
    const m = req.method()
    if (page.__adalSent || m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || req.resourceType() === 'ping') return
    const u = new URL(req.url())
    if (SIGN_IN.test(u.hostname) || SIGN_IN_PATH.test(u.pathname)) return
    page.__adalSent = `${m} ${u.hostname}${u.pathname}`.slice(0, 120)
  } catch { page.__adalSent = '?' }
}

export function browserLost(page, message) {
  if (LOST.test(String(message || ''))) return true
  try { return !!page && (page.isClosed?.() === true || page.browser?.()?.connected === false) } catch { return true }
}

/** → the line for the run's log when it goes back in line, or ''. */
export async function backInLine(db, job, page, message) {
  if (process.env.ADAL_LOST_BACK === '0' || !page || page.__adalSent || !browserLost(page, message)) return ''
  try {
    const row = await db('automation_queue').where('id', job.id).first('status', 'context')
    if (row?.status !== 'running') return ''              // stopped or ended meanwhile
    const ctx = JSON.parse(row.context || '{}') || {}
    if (ctx.lost_once) return ''
    ctx.lost_once = Date.now()
    const { seal } = await import('./accountVault.js')
    const n = await db('automation_queue').where({ id: job.id, status: 'running' }).update({ status: 'pending', pause_reason: null, context: seal(JSON.stringify(ctx)), updated_at: new Date().toISOString() })
    return n ? `The robot's tab was lost (${String(message || 'closed').slice(0, 80)}) before anything was sent — back in line, once` : ''
  } catch { return '' }
}
