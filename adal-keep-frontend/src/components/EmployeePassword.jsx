/**
 * Employees → an employee's password (backend routes/employees.js):
 *   mode "ask"   signing in as her: she types it
 *   mode "admin" the admin sees it and sets a new one (from any PC or phone)
 *   mode "self"  she changes her own
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Modal from './shared/Modal'
import Button from './shared/Button'

const err = (e) => e?.response?.data?.error || e.message
const field = 'w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm dark:border-slate-700 dark:bg-slate-900'

export default function EmployeePassword({ emp, mode, onClose, onSignIn }) {
  const [value, setValue] = useState('')
  const [shown, setShown] = useState(undefined)   // the admin's view: her password (null: not kept)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (mode !== 'admin' || !emp) return
    api.get(`/employees/${emp.id}/password`, { adalNoCache: true }).then(r => setShown(r.data?.password ?? null)).catch(e => { setShown(null); toast.error(err(e)) })
  }, [emp?.id, mode])
  if (!emp) return null

  const submit = async (e) => {
    e.preventDefault()
    if (!value) return
    if (mode === 'ask') return onSignIn(value)
    setBusy(true)
    try {
      await api.put(`/employees/${emp.id}/password`, { password: value })
      toast.success(mode === 'self' ? 'Your password is changed' : `${emp.name}'s new password is set — share it with them`)
      if (mode === 'admin') setShown(value)
      setValue('')
      if (mode === 'self') onClose()
    } catch (e2) { toast.error(err(e2)) } finally { setBusy(false) }
  }

  const title = mode === 'ask' ? `Sign in as ${emp.name}` : mode === 'self' ? 'Change my password' : `${emp.name}'s password`
  return (
    <Modal isOpen onClose={onClose} title={title} size="sm">
      <form onSubmit={submit} className="space-y-4">
        {mode === 'admin' && (
          <div className="rounded-xl bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800">
            {shown === undefined ? '…' : shown
              ? <>Password: <span className="select-all font-mono font-semibold">{shown}</span></>
              : <span className="text-slate-500">{emp.has_password ? 'Set before Adal Keep kept passwords: set a new one to see it.' : 'No password yet: anyone can sign in as them. Set one.'}</span>}
          </div>
        )}
        <input type={mode === 'ask' ? 'password' : 'text'} autoFocus value={value} onChange={(e) => setValue(e.target.value)}
          placeholder={mode === 'ask' ? 'Password' : 'New password (4 characters or more)'} className={field} autoComplete="off" />
        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
          <Button type="submit" isLoading={busy} disabled={!value || (mode !== 'ask' && value.length < 4)}>
            {mode === 'ask' ? 'Sign in' : 'Set password'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
