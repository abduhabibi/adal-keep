import { useEffect, useState } from 'react'
import api from '../services/api'

/**
 * A phone typed this agency's PC number and asks to join: "Yes, it's me"
 * lets it in (it goes on by itself), No turns it away. Shown on the agency's
 * PCs — never in the phone app or Adal Keep Admin.
 */
export default function JoinRequests() {
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(null)
  const off = import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_ADMIN === '1' || import.meta.env.VITE_DEMO === '1'
  useEffect(() => {
    if (off) return
    let alive = true
    const load = () => api.get('/mobile/join-requests').then(r => alive && setList(r.data || [])).catch(() => {})
    load()
    const t = setInterval(load, 4000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  if (off || !list.length) return null
  const r = list[0]
  const answer = async (ok) => {
    setBusy(ok ? 'yes' : 'no')
    try { await api.post(`/mobile/join-requests/${r.id}`, { ok }); setList(l => l.filter(x => x.id !== r.id)) }
    catch (e) { alert(e.response?.data?.error || e.message) }
    setBusy(null)
  }
  return (
    <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 p-5 shadow-2xl text-center space-y-3 animate-fade-up">
        <div className="text-5xl">📱</div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">{r.name || 'A phone'} wants to join</h2>
        <p className="text-sm text-slate-500">
          Someone typed this PC's number in the Adal Keep app. Yes lets that phone see and work on the agency's profiles, documents and runs.
        </p>
        <p className="text-xs text-slate-400">{new Date(r.created_at).toLocaleTimeString()}{list.length > 1 ? ` · ${list.length - 1} more waiting` : ''}</p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button type="button" disabled={!!busy} onClick={() => answer(false)}
            className="rounded-xl border border-slate-300 dark:border-slate-600 py-3 font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50">{busy === 'no' ? '…' : 'No'}</button>
          <button type="button" disabled={!!busy} onClick={() => answer(true)}
            className="rounded-xl bg-teal-600 hover:bg-teal-700 py-3 font-bold text-white disabled:opacity-50">{busy === 'yes' ? '…' : "Yes, it's me"}</button>
        </div>
      </div>
    </div>
  )
}
