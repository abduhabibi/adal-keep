/**
 * "Mark as done" moves her to the next stage (asked on 2026-11-21). The one
 * function behind every "✔️ … saved" / "done" control — the notification
 * pop-ups, a run's buttons, a step's tick, a journey step: the backend
 * (services/markDone.js) marks the step done and sets what her stage is read
 * from; every page here reloads at once (and every other PC and phone hears
 * the change). A toast offers Undo for 5 seconds.
 *
 * One of: runId (a paused run), workflowId (a step's card), step (a journey step).
 */
import toast from 'react-hot-toast'
import api from '../services/api'
import { tellChanged } from './changes'

// The "✔️ … saved" words of a paused run, by what it waits for.
export const DONE_LABEL = {
  'awaiting-human-submit': '✔️ Submit done',
  'awaiting-human-save':   '✔️ SAVE done',
  'awaiting-visa-save':    '✔️ Visa saved',
  'awaiting-insurance-save': '✔️ Insurance done',
  'awaiting-epro-save':      '✔️ EPRO saved',
  'awaiting-tasheer-save':   '✔️ Tasheer saved',
  'awaiting-visa-pay':       '✔️ Visa paid',
}
// The journey steps a person may mark done, and their words.
export const STEP_DONE_LABEL = {
  musaned: '✔️ On Musaned', selected: '✔️ Chosen', wafid: '✔️ Medical done (FIT)', epro: '✔️ EPRO approved',
  fmol: '✔️ LMIS contract done', insurance: '✔️ Insurance done', tasheer: '✔️ Tasheer saved', embassy: '✔️ Visa applied',
  visa: '✔️ Visa issued', police: '✔️ Police done', arrived: '✔️ Arrived',
}

// One request per step at a time (asked on 2026-11-23: it worked "only sometimes"): a second
// click while the first is on its way is dropped, and every page reloads once it answered.
const inFlight = new Set()
const once = async (key, fn) => {
  if (inFlight.has(key)) return null
  inFlight.add(key)
  try { return await fn() } finally { inFlight.delete(key) }
}
export const markBusy = (profileId, what) => inFlight.has(`${profileId}|${what}`)
// The Undo toasts still showing for her: a newer tick or untick replaces them (an older
// Undo would put back a state from before it; the server refuses that too).
const toasts = new Map()   // profileId → Set(toast id)
const showUndo = (profileId, id) => {
  for (const old of toasts.get(profileId) || []) if (old !== id) toast.dismiss(old)
  toasts.set(profileId, new Set([id]))
}
const undoButton = (tt, undo) => (
  <button type="button" className="shrink-0 rounded-lg border border-slate-300 px-2 py-0.5 text-xs font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
    onClick={async (e) => {
      e.currentTarget.disabled = true
      toast.dismiss(tt.id)
      try { const u = await api.post('/automations/undo-done', { undo }); reload(); toast.success(u.data?.message || 'Undone') }
      catch (err) { reload(); toast.error(err.response?.data?.error || 'Could not undo') }
    }}>Undo</button>
)

const reload = () => {
  tellChanged(['automation_queue', 'profiles'])
  window.dispatchEvent(new Event('adal-profile-changed'))
}

/** Steps a person may uncheck (not the CV: a document). */
export const STEP_UNDONE = ['musaned', 'selected', 'wafid', 'epro', 'insurance', 'fmol', 'embassy', 'visa', 'arrived', 'tasheer', 'police']

/** A done step goes back to open (and every later one): the 5 s Undo puts it back as it was. */
export function markUndone({ profileId, step, label = '' } = {}) {
  return once(`${profileId}|${step}`, async () => {
    try {
      const r = await api.post(`/profiles/${profileId}/steps/${step}/undone`, {})
      reload()
      const undo = r.data?.undo, id = `undone-${step}-${profileId}`
      showUndo(profileId, id)
      toast((tt) => (
        <span className="flex items-center gap-3 text-sm">
          <span>↩ {label ? `${label}: ` : ''}{r.data?.message || 'Unchecked'}</span>
          {undo && undoButton(tt, undo)}
        </span>
      ), { duration: 5000, id })
      return r.data
    } catch (e) {
      reload()
      toast.error(`${label ? `${label}: ` : ''}${e.response?.data?.error || e.message}`, { duration: 7000 })
      return null
    }
  })
}

/** A tick made by hand on a step's card taken back (same 5 s Undo). */
export function untick({ profileId, workflowId, label = '' } = {}) {
  return once(`${profileId}|${workflowId}`, async () => {
    try {
      const r = await api.post(`/profiles/${profileId}/automations/${workflowId}/mark-done`, { done: false })
      reload()
      const undo = r.data?.undo, id = `untick-${workflowId}-${profileId}`
      showUndo(profileId, id)
      toast((tt) => (
        <span className="flex items-center gap-3 text-sm">
          <span>↩ {label ? `${label}: ` : ''}{r.data?.message || 'Not done any more'}</span>
          {undo && undoButton(tt, undo)}
        </span>
      ), { duration: 5000, id })
      return r.data
    } catch (e) {
      reload()
      toast.error(`${label ? `${label}: ` : ''}${e.response?.data?.error || e.message}`, { duration: 7000 })
      return null
    }
  })
}

export function markDone({ profileId, workflowId, runId, step, label = '' } = {}) {
  const url = runId ? `/automations/${runId}/complete`
    : step ? `/profiles/${profileId}/steps/${step}/done`
    : `/profiles/${profileId}/automations/${workflowId}/mark-done`
  return once(`${profileId || ''}|${runId ? `run${runId}` : step || workflowId}`, async () => {
    try {
      const r = await api.post(url, runId || step ? {} : { done: true })
      reload()
      const undo = r.data?.undo, id = `done-${runId || workflowId || step}-${profileId || ''}`
      const words = `${label ? `${label.replace(/^✔️\s*/, '')}: ` : ''}${r.data?.message || 'Marked done'}`
      showUndo(profileId || r.data?.profile_id, id)
      toast((tt) => (
        <span className="flex items-center gap-3 text-sm">
          <span>✅ {words}</span>
          {undo && undoButton(tt, undo)}
        </span>
      ), { duration: 5000, id })
      return r.data
    } catch (e) {
      reload()
      toast.error(`${label ? `${label}: ` : ''}${e.response?.data?.error || e.message}`, { duration: 7000 })
      return null
    }
  })
}
