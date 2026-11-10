/**
 * Dashboard → Morning sign-in: every site the robots use, signed in or not.
 * Sign in to each once in the morning: Adal Keep keeps them signed in all day
 * (services/sessionKeeper.js) and the robots go straight to work there.
 */
import { useEffect, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'

const err = (e) => e?.response?.data?.error || e.message

export default function MorningSignIn() {
  const [sites, setSites] = useState(null)
  const load = () => api.get('/sessions').then(r => setSites(Array.isArray(r.data) ? r.data : [])).catch(() => setSites([]))
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t) }, [])
  if (!sites?.length) return null
  const open = async (s) => {
    try { await api.post(`/sessions/${s.key}/open`); toast.success(`Sign in to ${s.name} in the window that opened — it then stays signed in all day`, { duration: 7000 }) } catch (e) { toast.error(err(e)) }
    setTimeout(load, 8000)
  }
  const inCount = sites.filter(s => s.signedIn).length
  return (
    <div className="panel p-4">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="font-display font-bold">☀️ Morning sign-in <span className="ml-1 text-sm font-normal text-slate-500">{inCount} of {sites.length} signed in</span></p>
        <span className="text-xs text-slate-500">Sign in once — Adal Keep keeps each one signed in all day, out of sight.</span>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {sites.map(s => (
          <div key={s.key} className={`flex items-center gap-2 rounded-xl border px-3 py-2 ${s.signedIn ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-800 dark:bg-emerald-900/10' : 'border-slate-200 dark:border-slate-700'}`}>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${s.signedIn ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{s.name}</span>
            {s.signedIn
              ? <span className="text-xs font-semibold text-emerald-700 dark:text-emerald-300">Signed in</span>
              : <button type="button" onClick={() => open(s)} className="rounded-lg bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700">Sign in</button>}
          </div>
        ))}
      </div>
    </div>
  )
}
