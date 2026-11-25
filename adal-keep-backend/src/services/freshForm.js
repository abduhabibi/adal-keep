/**
 * freshForm.js — a sign-in form a person opens is filled (name and password, from the run's own account) and fresh
 * (2026-11-25: an empty form asked the person to sign in). Looked at once, when the person opens the live view.
 *
 *  - Only on the run's own site (its peer's addresses), only an empty password box, never over what a person typed
 *    (nothing of theirs in the last 30 s), never Sign in, never the tick.
 *  - Musaned, a run nobody is driving (paused): a form over a minute old has expired (wahid.sa) — opened again.
 *    (While the run itself waits, robotCheck.waitForTick does this.)
 * Off: ADAL_FRESH_FORM=0. Any error: the form stays as it is.
 */
import { hostOf, isPeerUrl, peerOf } from './tabManager.js'

const PERSON_MS = 30000
const PAIRS = [['musaned_username', 'musaned_password'], ['insurance_username', 'insurance_password'], ['visa_username', 'visa_password'], ['login_value', 'login_password']]
export const credsOf = (context) => {
  let c = {}
  try { c = typeof context === 'string' ? JSON.parse(context || '{}') : context || {} } catch {}
  const k = PAIRS.find(([u, p]) => c[u] && c[p])
  return k ? { user: String(c[k[0]]), password: String(c[k[1]]), account_id: c.account_id } : null
}

// In the page: the sign-in form, as it is.
export const FORM_IN_PAGE = () => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled && !e.readOnly }
  const pw = [...document.querySelectorAll('input[type="password"]')].filter(seen)
  if (pw.length !== 1) return null            // (none, or a "change password" page)
  const names = [...document.querySelectorAll('input')].filter(e => seen(e) && ['text', 'email', 'tel', ''].includes(e.getAttribute('type') || '') && !/otp|code|captcha/i.test(`${e.name} ${e.id}`) && (e.compareDocumentPosition(pw[0]) & Node.DOCUMENT_POSITION_FOLLOWING))
  return { password: !!pw[0].value, user: names.length ? names[names.length - 1].value : null, age: Date.now() - performance.timeOrigin, error: (document.querySelector('#input-error, .kc-feedback-text, #kc-error-message, .alert-error')?.innerText || '').trim().slice(0, 120) }
}
export const FILL_IN_PAGE = ({ user, password }) => {
  const seen = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !e.disabled && !e.readOnly }
  const pw = [...document.querySelectorAll('input[type="password"]')].filter(seen)
  if (pw.length !== 1 || pw[0].value) return false
  const names = [...document.querySelectorAll('input')].filter(e => seen(e) && ['text', 'email', 'tel', ''].includes(e.getAttribute('type') || '') && !/otp|code|captcha/i.test(`${e.name} ${e.id}`) && (e.compareDocumentPosition(pw[0]) & Node.DOCUMENT_POSITION_FOLLOWING))
  const name = names[names.length - 1] || null
  if (name && name.value && name.value !== user) return false       // another name is there: a person's
  const put = (e, v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, v); for (const t of ['input', 'change']) e.dispatchEvent(new Event(t, { bubbles: true })) }
  if (name && !name.value) put(name, user)
  put(pw[0], password)
  return true
}

/** → '' (nothing to do) | 'filled' | 'fresh' */
export async function freshForm(db, runId, page, { freshMs = 60000, now = Date.now, reloaded = false } = {}) {
  if (process.env.ADAL_FRESH_FORM === '0' || !/^\d+$/.test(String(runId)) || page.__adalFreshing) return ''
  if (!reloaded && (now() - (page.__adalFreshAt || 0) < 15000 || now() - (page.__adalInputAt || 0) < PERSON_MS)) return ''
  page.__adalFreshing = true
  try {
    const run = await db('automation_queue').where('id', runId).first('id', 'workflow_id', 'status', 'context')
    if (!run || !['running', 'paused'].includes(run.status)) return ''
    const peer = peerOf(run.workflow_id), creds = credsOf(run.context)
    if (!peer || !creds || !isPeerUrl(page.url(), peer)) return ''
    const within = (p, ms) => { let t; return Promise.race([Promise.resolve(p).catch(() => null), new Promise(r => { t = setTimeout(() => r(null), ms) })]).finally(() => clearTimeout(t)) }
    const f = await within(page.evaluate(FORM_IN_PAGE), 4000)
    if (!f) return ''
    page.__adalFreshAt = now()
    // Musaned, nobody driving: an old (or timed-out) form is opened again. Not with the tick already on it.
    if (peer === 'musaned' && run.status === 'paused' && (f.age > freshMs || /timed? ?out|expired/i.test(f.error)) && /(^|\.)wahid\.sa$/.test(hostOf(page.url()))) {
      const { robotCheck } = await import('./robotCheck.js')
      if (!(await robotCheck(page)).ticked) {
        const w = await import('./musanedWorkflow.js')
        const ctx = { runId: run.id, profileId: '-', profileName: '', onLog: () => {}, notify: async () => {}, isCancelled: () => false }
        page.__adalRootAt = 0                      // (stepOpenMusaned loads Musaned's sign-in fresh then)
        const o = await w.stepOpenMusaned(page, ctx)
        if (o?.onKeycloak !== false) await within(page.evaluate(FILL_IN_PAGE, creds), 4000)
        console.log(`[live] run #${run.id}: its sign-in form was ${Math.round(f.age / 1000)} s old — opened fresh and filled for the person`)
        return 'fresh'
      }
    }
    if (!f.password && await within(page.evaluate(FILL_IN_PAGE, creds), 4000)) {
      console.log(`[live] run #${run.id}: its sign-in form was empty — filled for the person`)
      return 'filled'
    }
    return ''
  } catch (e) { console.warn(`[live] run #${runId}: the form stays as it is (${e.message})`); return '' } finally { page.__adalFreshing = false }
}

/** The person pressed Reload in the live view: the new form is empty — filled at once (as soon as it is drawn). */
export async function refillAfterReload(db, runId, page, { tries = [0, 400, 1200, 3000, 6000] } = {}) {
  for (const ms of tries) {
    await new Promise(r => setTimeout(r, ms))
    if (page.isClosed?.()) return ''
    const done = await freshForm(db, runId, page, { reloaded: true })
    if (done) return done
    const there = await Promise.race([page.evaluate(FORM_IN_PAGE).catch(() => null), new Promise(r => setTimeout(() => r(null), 3000))])
    if (there?.password) return ''                         // filled already (the run itself, the browser)
  }
  return ''
}
