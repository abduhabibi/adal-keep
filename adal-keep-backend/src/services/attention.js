/**
 * attention.js — what needs a person right now, for the notification bar
 * (frontend AttentionBar). No window opens for it: the bar shows the call with
 * a small beep. A picture captcha shows in the bar with an input: what is typed
 * there goes into the tab and the run finishes the step by itself.
 */
const waits = new Map() // run id → { title, body, at, image, answer }

/** A run is waiting for a person (a sign-in, a code, a reCAPTCHA …). */
export function needPerson(runId, title, body = '') {
  const id = Number(runId)
  waits.set(id, { ...(waits.get(id) || {}), title, body: String(body || '').slice(0, 300), at: Date.now() })
}

/** The captcha picture (a data: address), and what to do with the typed text. */
export function askCaptcha(runId, image, answer) {
  const id = Number(runId)
  waits.set(id, { title: 'Type the captcha', body: '', at: Date.now(), ...(waits.get(id) || {}), image, answer })
}

/** Done with this call. keepCaptcha: a paused run's captcha stays in the bar. */
export function doneWith(runId, { keepCaptcha = false } = {}) {
  const id = Number(runId)
  if (!keepCaptcha || !waits.get(id)?.image) waits.delete(id)
}

export const waiting = () => [...waits.entries()].map(([run_id, w]) => ({ run_id, title: w.title, body: w.body, at: w.at, image: w.image || null }))

export async function answerCaptcha(runId, text) {
  const id = Number(runId)
  const w = waits.get(id)
  if (!w?.answer) throw new Error('This run is not waiting for a captcha any more')
  const answer = w.answer
  waits.set(id, { ...w, image: null, answer: null, body: 'Captcha sent — checking it…' })
  await answer(String(text).trim())
}
