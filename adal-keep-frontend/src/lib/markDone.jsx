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

const reload = () => {
  tellChanged(['automation_queue', 'profiles'])
  window.dispatchEvent(new Event('adal-profile-changed'))
}

export async function markDone({ profileId, workflowId, runId, step, label = '' } = {}) {
  const url = runId ? `/automations/${runId}/complete`
    : step ? `/profiles/${profileId}/steps/${step}/done`
    : `/profiles/${profileId}/automations/${workflowId}/mark-done`
  try {
    const r = await api.post(url, runId || step ? {} : { done: true })
    reload()
    const undo = r.data?.undo
    const words = `${label ? `${label.replace(/^✔️\s*/, '')}: ` : ''}${r.data?.message || 'Marked done'}`
    toast((tt) => (
      <span className="flex items-center gap-3 text-sm">
        <span>✅ {words}</span>
        {undo && (
          <button type="button" className="shrink-0 rounded-lg border border-slate-300 px-2 py-0.5 text-xs font-semibold hover:bg-slate-100 dark:border-slate-600 dark:hover:bg-slate-800"
            onClick={async () => {
              toast.dismiss(tt.id)
              try { const u = await api.post('/automations/undo-done', { undo }); reload(); toast.success(u.data?.message || 'Undone') }
              catch (e) { toast.error(e.response?.data?.error || 'Could not undo') }
            }}>Undo</button>
        )}
      </span>
    ), { duration: 5000, id: `done-${runId || workflowId || step}-${profileId || ''}` })
    return r.data
  } catch (e) {
    toast.error(`${label ? `${label}: ` : ''}${e.response?.data?.error || e.message}`, { duration: 7000 })
    return null
  }
}
