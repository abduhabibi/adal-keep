/**
 * Settings → Software Updates: "Go back to previous version" (admins only).
 * This PC goes back to the release before, signed by Adal in advance, and the
 * office's other PCs follow over the network (routes/systemUpdate.js
 * /update/rollback, services/rollback.js). Refused with the reason when the
 * newer version already changed the database.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'
import { useAuth } from '../context/AuthContext'
import Button from './shared/Button'
import Modal from './shared/Modal'

export default function RollbackCard() {
  const { user } = useAuth()
  const [plan, setPlan] = useState(null)
  const [ask, setAsk] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [force, setForce] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => { api.get('/system/update/rollback').then(r => setPlan(r.data)).catch(() => {}) }, [])
  // An employee signed in does not see it (the server refuses them too).
  if (user && !['owner', 'admin'].includes(user.role)) return null
  if (!plan || (!plan.available && !plan.refused)) return null

  const go = async () => {
    setBusy(true); setMsg('')
    try {
      const r = await api.post('/system/update/rollback', force ? { force: true } : {})
      setMsg(r.data?.message || 'Done.')
      setDone(true)
    } catch (e) {
      setMsg(e.response?.data?.error || 'Could not go back.')
      if (e.response?.data?.busy) setForce(true)
    } finally { setBusy(false) }
  }

  return (
    <div className="p-4 rounded-xl border bg-white dark:bg-slate-900 text-sm flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h3 className="font-medium">Go back to previous version</h3>
        {plan.available
          ? <p className="text-slate-500">If <code translate="no" className="font-mono">{plan.from}</code> has a problem, every PC of this office goes back to <code translate="no" className="font-mono">{plan.to}</code> (over the office network first). Your data is kept.</p>
          : <p className="text-amber-700 dark:text-amber-300">{plan.reason}</p>}
      </div>
      {plan.available && !done && <Button onClick={() => { setMsg(''); setAsk(true) }} className="bg-amber-600 hover:bg-amber-700 shrink-0">Go back to previous version</Button>}
      <Modal isOpen={ask} onClose={() => !busy && setAsk(false)} title="Go back to the previous version?">
        <div className="space-y-4 text-sm">
          {msg
            ? <p className="whitespace-pre-wrap break-words">{msg}</p>
            : <p>This PC goes back from <b translate="no">{plan.from}</b> to <b translate="no">{plan.to}</b> and restarts; the other PCs of this office follow within a few minutes. It stays there until Adal publishes a newer version.</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setAsk(false)} disabled={busy}>Close</Button>
            {!done && <Button onClick={go} isLoading={busy} className="bg-amber-600 hover:bg-amber-700">{force ? 'Go back anyway' : 'Go back'}</Button>}
          </div>
        </div>
      </Modal>
    </div>
  )
}
