/**
 * attention.js — what needs a person right now, as tasks (frontend
 * AttentionBar). No window opens for it. A picture captcha or a code shows
 * with an input: what is typed there goes into the tab and the run finishes the
 * step by itself.
 *
 * Human steps are tasks, not a flood of notices (asked on 2026-11-21): one
 * task per human step (a captcha to tick, a Tasheer time slot to pick, a code
 * to type …), grouped per run (`step`: the run's 1st, 2nd … human step), each
 * opening that run's live browser with one click. A task nobody answers for 5
 * minutes goes away and the run is paused cleanly (worker.js onTaskExpired:
 * it stops before its next step, nothing half-sent). One gentle sound per run,
 * not per step (worker.js beepFor).
 */
export const TASK_MS = Number(process.env.ADAL_TASK_MS) || 5 * 60e3
const waits = new Map() // run id → { title, body, at, image, answer, label, confirm, step, kind }
const steps = new Map() // run id → how many human steps it asked so far
const listeners = new Set()
/** Called when a run starts waiting for a person (worker.js: the next run may start). */
export const onWait = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
// Any change of the list (a call comes or goes): cloudSync puts it online, so a
// phone with the app closed sees it (its own background look, AdalNoticeJob).
const watchers = new Set()
export const onAttentionChange = (fn) => { watchers.add(fn); return () => watchers.delete(fn) }
const changed = () => { for (const fn of watchers) { try { fn() } catch {} } }
const told = () => { for (const fn of listeners) { try { fn() } catch {} } changed() }
/** Is this run waiting for a person right now? */
export const isWaiting = (runId) => waits.has(Number(runId))

// A task left unanswered: worker.js pauses its run.
const expiries = new Set()
export const onTaskExpired = (fn) => { expiries.add(fn); return () => expiries.delete(fn) }

/** What kind of step it is, from its words: the task list shows it with its own short label. */
export function kindOf(title = '', { image = null, answer = null, choices = null, confirm = false } = {}) {
  const t = String(title)
  if (confirm) return 'confirm'
  if (/time ?slot|appointment|slot/i.test(t)) return 'slot'
  if (/recaptcha|not a robot|tick/i.test(t)) return 'tick'
  if (image || /captcha/i.test(t)) return 'captcha'
  if (/code|otp|sms/i.test(t)) return 'code'
  if (choices) return 'choice'
  if (/sign ?in|log ?in/i.test(t)) return 'signin'
  return answer ? 'answer' : 'look'
}

// A new step of the run: a new task (its own 5 minutes). The same step said again keeps its time.
function put(id, next) {
  const had = waits.get(id)
  const same = had && had.title === next.title
  const step = same ? had.step : (steps.get(id) || 0) + 1
  if (!same) steps.set(id, step)
  const w = { ...(had || {}), ...next, step, at: same ? had.at : Date.now() }
  w.kind = kindOf(w.title, w)
  waits.set(id, w)
}

/** A run is waiting for a person (a sign-in, a code, a reCAPTCHA …). */
export function needPerson(runId, title, body = '', { confirm = false } = {}) {
  const id = Number(runId)
  put(id, { title, body: String(body || '').slice(0, 300), confirm })
  told()
}

/**
 * A question answered in the bar: the captcha picture (a data: address) or a
 * code with no picture, and what to do with the typed text.
 */
export function askCaptcha(runId, image, answer, { title, label = 'Numbers', choices = null, phoneAfterMs = 0 } = {}) {
  const id = Number(runId)
  // phoneAfterMs: the phones are not shown it before then (it goes to this PC first).
  const had = waits.get(id)
  put(id, { title: title || had?.title || 'Type the captcha', body: had?.body || '', image, answer, label, choices, phoneFrom: phoneAfterMs ? Date.now() + phoneAfterMs : 0 })
  told()
}

/**
 * Done with this call. keepCaptcha: a paused run's question stays in the bar. A
 * confirmation (Save is a person's) stays after the run ends, until the person
 * says it is done (force) or its 5 minutes are over.
 */
export function doneWith(runId, { keepCaptcha = false, force = false } = {}) {
  const id = Number(runId), w = waits.get(id)
  if (w?.confirm && !force) return
  if ((!keepCaptcha || !w?.answer) && waits.delete(id)) changed()
}

/** The run is over: its next run starts counting its steps from 1 again. */
export function forgetRun(runId) { steps.delete(Number(runId)) }

export const waiting = (now = Date.now()) => [...waits.entries()].map(([run_id, w]) => ({
  run_id, task_id: `${run_id}:${w.step}`, step: w.step, kind: w.kind, title: w.title, body: w.body, at: w.at,
  expires_in_ms: Math.max(0, w.at + TASK_MS - now),
  asks: !!w.answer, label: w.label, choices: w.choices || null, confirm: !!w.confirm, image: w.image || null,
  phone_wait_ms: w.answer && w.phoneFrom ? Math.max(0, w.phoneFrom - now) : 0,
}))

export async function answerCaptcha(runId, text) {
  const id = Number(runId)
  const w = waits.get(id)
  if (!w?.answer) throw new Error('This run is not waiting for a captcha any more')
  const answer = w.answer
  // Sent: the notice goes (a code that is not accepted comes back as a new one).
  waits.delete(id)
  changed()
  await answer(String(text).trim())
}

/** Tasks nobody answered for 5 minutes go; their runs are paused (onTaskExpired). */
export function expireTasks(now = Date.now()) {
  const gone = []
  for (const [id, w] of waits) {
    if (now - w.at < TASK_MS) continue
    waits.delete(id)
    gone.push({ run_id: id, title: w.title, kind: w.kind, step: w.step })
  }
  if (!gone.length) return gone
  changed()
  for (const g of gone) for (const fn of expiries) { try { Promise.resolve(fn(g.run_id, g)).catch(() => {}) } catch {} }
  return gone
}
setInterval(() => expireTasks(), 10_000).unref?.()
