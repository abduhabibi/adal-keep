/**
 * attention.js — what needs a person right now, for the notification bar
 * (frontend AttentionBar). No window opens for it: the bar shows the call with
 * a small beep. A picture captcha or a code shows in the bar with an input: what
 * is typed there goes into the tab and the run finishes the step by itself.
 */
const waits = new Map() // run id → { title, body, at, image, answer, label, confirm }

/** A run is waiting for a person (a sign-in, a code, a reCAPTCHA …). */
export function needPerson(runId, title, body = '', { confirm = false } = {}) {
  const id = Number(runId)
  waits.set(id, { ...(waits.get(id) || {}), title, body: String(body || '').slice(0, 300), at: Date.now(), confirm })
}

/**
 * A question answered in the bar: the captcha picture (a data: address) or a
 * code with no picture, and what to do with the typed text.
 */
export function askCaptcha(runId, image, answer, { title, label = 'Numbers', choices = null, phoneAfterMs = 0 } = {}) {
  const id = Number(runId)
  // phoneAfterMs: the phones are not shown it before then (it goes to this PC first).
  const w = { title: 'Type the captcha', body: '', at: Date.now(), ...(waits.get(id) || {}), image, answer, label, choices, phoneFrom: phoneAfterMs ? Date.now() + phoneAfterMs : 0 }
  waits.set(id, title ? { ...w, title, at: Date.now() } : w)
}

/**
 * Done with this call. keepCaptcha: a paused run's question stays in the bar. A
 * confirmation (Save is a person's) stays after the run ends, until the person
 * says it is done (force).
 */
export function doneWith(runId, { keepCaptcha = false, force = false } = {}) {
  const id = Number(runId), w = waits.get(id)
  if (w?.confirm && !force) return
  if (!keepCaptcha || !w?.answer) waits.delete(id)
}

export const waiting = () => [...waits.entries()].map(([run_id, w]) => ({ run_id, title: w.title, body: w.body, at: w.at, asks: !!w.answer, label: w.label, choices: w.choices || null, confirm: !!w.confirm, image: w.image || null, phone_wait_ms: w.answer && w.phoneFrom ? Math.max(0, w.phoneFrom - Date.now()) : 0 }))

export async function answerCaptcha(runId, text) {
  const id = Number(runId)
  const w = waits.get(id)
  if (!w?.answer) throw new Error('This run is not waiting for a captcha any more')
  const answer = w.answer
  waits.set(id, { ...w, image: null, answer: null, choices: null, body: 'Sent — checking it…' })
  await answer(String(text).trim())
}
