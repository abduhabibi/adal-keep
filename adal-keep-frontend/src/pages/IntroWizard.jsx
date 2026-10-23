import { useState } from 'react'
import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'

export default function IntroWizard() {
  const { completeSetup } = useAuth()
  const [step, setStep] = useState(1)
  const [form, setForm] = useState({
    companyName: '',
    companyPhone: '',
    ceoName: '',
    ceoPhone: '',
    devPassword: '',
  })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  const next = () => setStep(s => s + 1)
  const prev = () => setStep(s => s - 1)

  const submit = async (e) => {
    e.preventDefault(); setBusy(true)
    try {
      // Map wizard fields onto the columns the backend stores.
      await completeSetup({
        companyName: form.companyName.trim(),
        ceoName: form.ceoName.trim(),
        phone1: form.companyPhone.trim(), // company line
        phone2: form.ceoPhone.trim(),     // owner line
        devPassword: form.devPassword,
      })
      toast.success(`Adal ${form.companyName} activated! Trial started.`)
      document.title = `Adal ${form.companyName}`
      window.location.reload()
    } catch (err) {
      toast.error(err.response?.data?.error || 'Setup failed')
    } finally { setBusy(false) }
  }

  const inp = "w-full p-4 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-800 dark:text-white text-base focus:outline-none focus:border-teal-500 transition-all"

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-teal-950 to-slate-950 flex items-center justify-center p-6 overflow-hidden relative">
      {/* Animated background elements */}
      <div className="absolute inset-0 bg-[radial-gradient(#0ea5e9_0.8px,transparent_1px)] [background-size:40px_40px] opacity-10"></div>

      <div className="max-w-md w-full bg-white/95 dark:bg-slate-900/95 rounded-3xl shadow-2xl border border-white/20 p-10 relative z-10">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-20 h-20 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 text-white text-5xl font-bold mb-6 shadow-inner">አ</div>
          <h1 className="text-4xl font-bold text-slate-900 dark:text-white tracking-tight">Welcome to Adal</h1>
          <p className="text-slate-500 dark:text-slate-400 mt-3 text-lg">Let's set up your agency</p>
        </div>

        {step === 1 && (
          <div className="space-y-6 animate-fade-in">
            <div>
              <label className="block text-sm font-semibold text-slate-500 dark:text-slate-400 mb-2">Company / Agency Name</label>
              <input required value={form.companyName} onChange={set('companyName')} placeholder="e.g. Adal Recruitment" className={inp} />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-500 dark:text-slate-400 mb-2">Company Phone Number</label>
              <input required type="tel" value={form.companyPhone} onChange={set('companyPhone')} placeholder="e.g. +251 911 000 000" className={inp} />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-500 dark:text-slate-400 mb-2">CEO / Owner Name</label>
              <input value={form.ceoName} onChange={set('ceoName')} placeholder="e.g. Abdurahman Surur" className={inp} />
            </div>
            <div>
              <label className="block text-sm font-semibold text-slate-500 dark:text-slate-400 mb-2">CEO / Owner Phone</label>
              <input type="tel" value={form.ceoPhone} onChange={set('ceoPhone')} placeholder="e.g. +251 922 111 111" className={inp} />
            </div>
            <button onClick={next} disabled={!form.companyName.trim() || !form.companyPhone.trim()} className="w-full py-4 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-500 hover:to-cyan-500 disabled:opacity-40 text-white font-semibold rounded-2xl text-lg transition-all shadow-lg">
              Continue →
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-8 animate-fade-in">
            <div>
              <label className="block text-sm font-semibold text-slate-500 dark:text-slate-400 mb-2">Developer Master Password</label>
              <input required type="password" value={form.devPassword} onChange={set('devPassword')} placeholder="Enter the master password" className={inp} />
              <p className="text-xs text-slate-400 dark:text-slate-500 mt-2">
                The master password supplied with your copy of Adal. It unlocks the system and starts your 7-day trial.
              </p>
            </div>
            <div className="flex gap-4">
              <button onClick={prev} className="flex-1 py-4 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 font-semibold rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-all">Back</button>
              <button onClick={submit} disabled={busy || !form.devPassword.trim()} className="flex-1 py-4 bg-gradient-to-r from-teal-600 to-cyan-600 hover:from-teal-500 hover:to-cyan-500 disabled:opacity-40 text-white font-semibold rounded-2xl text-lg transition-all shadow-lg">
                {busy ? 'Activating...' : 'Activate Adal ' + (form.companyName || 'Agency')}
              </button>
            </div>
          </div>
        )}

        <div className="text-center mt-8 text-xs text-slate-400 dark:text-slate-500">
          Step {step} of 2 • Secure & Private Setup
        </div>
      </div>
    </div>
  )
}
