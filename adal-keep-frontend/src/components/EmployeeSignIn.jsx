/**
 * Employees → 🔑 Sign-in: her username (5 letters) and PIN (6 digits) for
 * another computer's Adal Companion ("Sign in to the main PC"). Set on the
 * main PC only. The PIN is shown here once, to write down — it is kept hashed.
 */
import { useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import Modal from './shared/Modal'

const suggest = (name) => String(name || '').toLowerCase().replace(/[^a-z]/g, '').padEnd(5, 'x').slice(0, 5)
const newPin = () => String(Math.floor(100000 + Math.random() * 900000))

export default function EmployeeSignIn({ emp, onSaved }) {
  const [open, setOpen] = useState(false)
  const [username, setUsername] = useState('')
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(null)

  const show = (e) => {
    e.stopPropagation()
    setUsername(/^[a-z]{5}$/.test(emp.username || '') ? emp.username : suggest(emp.name))
    setPin(newPin()); setDone(null); setOpen(true)
  }
  const save = async () => {
    if (!/^[a-z]{5}$/.test(username)) return toast.error('The username is 5 letters (a–z)')
    if (!/^\d{6}$/.test(pin)) return toast.error('The PIN is 6 digits')
    setBusy(true)
    try {
      const { data } = await api.put(`/employees/${emp.id}/sign-in`, { username, pin })
      setDone({ username: data.username, pin })
      onSaved?.()
    } catch (e) { toast.error(e?.response?.data?.error || e.message) }
    setBusy(false)
  }
  const box = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2 text-lg tracking-widest font-mono'

  return (
    <>
      <button type="button" onClick={show} className="mt-3 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-1 text-xs font-semibold text-slate-600 dark:text-slate-300 hover:border-teal-400 hover:text-teal-600">
        🔑 Sign-in for other computers
      </button>
      <Modal isOpen={open} onClose={() => setOpen(false)} title={`${emp.name}: sign-in for other computers`}>
        <div onClick={(e) => e.stopPropagation()} className="space-y-3">
          {done ? (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-300">Saved. On the other computer's Adal Companion ("Sign in to the main PC") type:</p>
              <div className="rounded-xl bg-teal-50 dark:bg-teal-900/30 p-4 font-mono text-lg">
                <div>Username: <b>{done.username}</b></div>
                <div>PIN: <b>{done.pin}</b></div>
              </div>
              <p className="text-xs text-slate-500">Write the PIN down now: it is not shown again (a new one can be set any time here).</p>
              <button type="button" onClick={() => setOpen(false)} className="w-full rounded-lg bg-teal-600 py-2 font-semibold text-white">Done</button>
            </>
          ) : (
            <>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">Username — 5 letters
                <input value={username} maxLength={5} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/[^a-z]/g, '').slice(0, 5))} className={box} autoComplete="off" />
              </label>
              <label className="block text-xs font-medium text-slate-600 dark:text-slate-300">PIN — 6 digits
                <div className="flex gap-2">
                  <input value={pin} maxLength={6} inputMode="numeric" onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))} className={box} autoComplete="off" />
                  <button type="button" onClick={() => setPin(newPin())} className="shrink-0 rounded-lg border border-slate-300 dark:border-slate-600 px-3 text-xs">New PIN</button>
                </div>
              </label>
              <button type="button" disabled={busy || username.length !== 5 || pin.length !== 6} onClick={save} className="w-full rounded-lg bg-teal-600 py-2 font-semibold text-white disabled:opacity-50">
                {busy ? 'Saving…' : 'Save sign-in'}
              </button>
              <p className="text-xs text-slate-500">Only on the main PC. Changing it here makes the old PIN stop working.</p>
            </>
          )}
        </div>
      </Modal>
    </>
  )
}
