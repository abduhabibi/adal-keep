/**
 * First-run sign-up (flag "agency_signup", see backend services/agencyConfig.js):
 * the agency types its name, phone and e-mail once. That creates the agency in
 * Supabase as "new, waiting for setup" and Adal does the setup from Adal Keep
 * Admin. Flag off, or already signed up → the normal first-start wizard.
 * SignupBanner tells the agency where it stands until Adal presses Ready.
 */
import { useEffect, useState } from 'react'
import api from '../services/api'
import IntroWizard from './IntroWizard'

const input = 'w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-2.5 text-sm'

export default function SignUpAgency() {
  const [st, setSt] = useState(null)
  const [f, setF] = useState({ name: '', phone: '', email: '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { api.get('/signup/state').then(r => setSt(r.data)).catch(() => setSt({ enabled: false })) }, [])
  if (!st) return null
  if (!st.enabled || st.status !== 'none') return <IntroWizard />
  const send = async (e) => {
    e.preventDefault()
    if (busy) return
    setBusy(true); setError('')
    try { await api.post('/signup', f); setSt({ enabled: true, status: 'new' }) }
    catch (err) { setError(err.response?.data?.error || err.message); setBusy(false) }
  }
  const set = (k) => (e) => setF(v => ({ ...v, [k]: e.target.value }))
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-950 p-4">
      <form onSubmit={send} className="panel w-full max-w-md p-6 space-y-4">
        <h1 className="text-xl font-bold text-slate-800 dark:text-white">Welcome to Adal Keep</h1>
        <p className="text-sm text-slate-600 dark:text-slate-300">Tell us who you are. Adal Keep prepares your agency's setup for you — you do not need to do anything else.</p>
        <label className="block text-sm">Agency name<input className={input} value={f.name} onChange={set('name')} autoFocus required maxLength={120} /></label>
        <label className="block text-sm">Phone<input className={input} value={f.phone} onChange={set('phone')} inputMode="tel" placeholder="09…" required /></label>
        <label className="block text-sm">E-mail<input className={input} value={f.email} onChange={set('email')} type="email" required /></label>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button disabled={busy} className="w-full px-6 py-3 bg-teal-600 hover:bg-teal-700 text-white font-semibold rounded-xl disabled:opacity-60">{busy ? 'Sending…' : 'Continue →'}</button>
      </form>
    </div>
  )
}

export function SignupBanner() {
  const [st, setSt] = useState(null)
  const [gone, setGone] = useState(() => { try { return localStorage.getItem('signup-ready-seen') === '1' } catch { return false } })
  useEffect(() => {
    let live = true
    const look = () => api.get('/signup/state').then(r => live && setSt(r.data)).catch(() => {})
    look(); const t = setInterval(look, 5 * 60000)
    return () => { live = false; clearInterval(t) }
  }, [])
  if (!st?.enabled || !['new', 'setup', 'ready'].includes(st.status) || (st.status === 'ready' && gone)) return null
  const ready = st.status === 'ready'
  return (
    <div className={`fixed bottom-4 end-4 z-50 max-w-xs rounded-xl shadow-lg p-3 text-sm ${ready ? 'bg-teal-600 text-white' : 'bg-amber-100 text-amber-900'}`}>
      {ready ? 'Adal Keep is ready for your agency. Setup is done.' : 'Your agency is new — Adal Keep is preparing your setup. You can start working meanwhile.'}
      {ready && <button className="ml-2 underline" onClick={() => { try { localStorage.setItem('signup-ready-seen', '1') } catch {} setGone(true) }}>OK</button>}
    </div>
  )
}
