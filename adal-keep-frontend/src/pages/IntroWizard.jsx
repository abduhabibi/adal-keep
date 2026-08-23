import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'

export default function IntroWizard() {
  const { completeSetup } = useAuth()
  const [form, setForm] = useState({ devPassword: '', companyName: '', ceoName: '', phone1: '', phone2: '', phone3: '', intakeNumber: '' })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })
  const inp = "w-full p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-white text-sm"

  const submit = async (e) => {
    e.preventDefault(); setBusy(true)
    try { await completeSetup(form); toast.success('Company activated — trial started!'); window.location.reload() }
    catch (err) { toast.error(err.response?.data?.error || 'Setup failed') }
    finally { setBusy(false) }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <form onSubmit={submit} className="max-w-lg w-full bg-white dark:bg-slate-800 rounded-2xl shadow-xl border border-slate-200 dark:border-slate-700 p-8 space-y-3">
        <div className="text-center mb-2">
          <div className="w-14 h-14 mx-auto rounded-2xl bg-teal-600 text-white flex items-center justify-center text-2xl font-bold mb-3">አ</div>
          <h1 className="text-2xl font-bold text-slate-800 dark:text-white">Activate Adal Keep</h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">Installer authorization required • 7-day free trial starts now</p>
        </div>
        <input required type="password" value={form.devPassword} onChange={set('devPassword')} placeholder="Developer master password *" className={inp} />
        <div className="border-t border-slate-200 dark:border-slate-700 pt-3" />
        <input required value={form.companyName} onChange={set('companyName')} placeholder="Company / Agency name *" className={inp} />
        <input value={form.ceoName} onChange={set('ceoName')} placeholder="CEO / Owner name" className={inp} />
        <div className="grid grid-cols-3 gap-2">
          <input required value={form.phone1} onChange={set('phone1')} placeholder="Number 1 *" className={inp} />
          <input value={form.phone2} onChange={set('phone2')} placeholder="Number 2" className={inp} />
          <input value={form.phone3} onChange={set('phone3')} placeholder="Number 3" className={inp} />
        </div>
        <input value={form.intakeNumber} onChange={set('intakeNumber')} placeholder="Company WhatsApp intake number (2519...)" className={inp} />
        <button disabled={busy} className="w-full py-3 bg-teal-600 hover:bg-teal-700 disabled:opacity-50 text-white font-semibold rounded-xl transition-colors">
          {busy ? 'Activating...' : 'Activate & Start Trial →'}
        </button>
      </form>
    </div>
  )
}
