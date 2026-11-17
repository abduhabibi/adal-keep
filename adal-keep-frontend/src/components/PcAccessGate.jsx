import { useEffect, useState } from 'react'
import api from '../services/api'

/**
 * Opened from another computer (an Adal Companion PC, a branch PC, a laptop):
 * it types the main PC's number (5 digits, in the main PC's Settings — the one
 * phones are added with) and is in at once. Nobody at the main PC approves
 * anything. Typed once — the key stays in this browser.
 */
export default function PcAccessGate() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [number, setNumber] = useState('')

  useEffect(() => {
    api.get('/pc-access/status').then(r => { if (r.data.state === 'approved') location.reload() }).catch(() => {})
  }, [])

  const signIn = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    let name = ''
    try { name = localStorage.getItem('adal_pc_name') || '' } catch {}
    try {
      await api.post('/pc-access/number', { number, name: name || 'Adal Companion PC' })
      location.reload()
    } catch (er) { setError(er.response?.data?.error || er.message); setBusy(false) }
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-800 p-6 shadow-xl text-center space-y-4 animate-fade-up">
        <div className="text-5xl">🔐</div>
        <form onSubmit={signIn} className="space-y-3">
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">PC number</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">The main PC's 6-digit PC number.</p>
          <input value={number} onChange={e => setNumber(e.target.value.replace(/\D/g, '').slice(0, 6))} autoFocus required
            inputMode="numeric" placeholder="••••••"
            className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-3 text-center font-mono text-2xl tracking-[0.4em]" />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button disabled={busy || number.length < 5} className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 py-3 font-bold text-white disabled:opacity-50">
            {busy ? 'Opening…' : 'Open Adal Keep'}
          </button>
        </form>
      </div>
    </div>
  )
}

/** On the main PC: "Computer X wants to open Adal Keep" — Yes / No. */
export function PcAccessRequests() {
  const [list, setList] = useState([])
  const [busy, setBusy] = useState(null)
  const off = import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_ADMIN === '1' || import.meta.env.VITE_DEMO === '1'
  useEffect(() => {
    if (off) return
    let alive = true
    const load = () => api.get('/pc-access/pending').then(r => alive && setList(r.data || [])).catch(() => {})
    load()
    const t = setInterval(load, 4000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  if (off || !list.length) return null
  const r = list[0]
  const answer = async (yes) => {
    setBusy(yes ? 'yes' : 'no')
    try { await api.post('/pc-access/answer', { id: r.id, yes }); setList(l => l.filter(x => x.id !== r.id)) }
    catch (e) { alert(e.response?.data?.error || e.message) }
    setBusy(null)
  }
  return (
    <div className="fixed inset-0 z-[120] bg-black/50 flex items-center justify-center p-4">
      <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 p-5 shadow-2xl text-center space-y-3 animate-fade-up">
        <div className="text-5xl">💻</div>
        <h2 className="text-lg font-bold text-slate-900 dark:text-white">{r.name} wants to open Adal Keep</h2>
        <p className="text-sm text-slate-500">
          A computer at <b>{r.ip}</b> asks to open this PC's Adal Keep: every profile, passport and portal password. Say Yes only if it is one of yours.
        </p>
        <p className="text-xs text-slate-400">{new Date(r.at).toLocaleTimeString()}{list.length > 1 ? ` · ${list.length - 1} more waiting` : ''}</p>
        <div className="grid grid-cols-2 gap-2 pt-1">
          <button type="button" disabled={!!busy} onClick={() => answer(false)}
            className="rounded-xl border border-slate-300 dark:border-slate-600 py-3 font-semibold text-slate-700 dark:text-slate-200 disabled:opacity-50">{busy === 'no' ? '…' : 'No'}</button>
          <button type="button" disabled={!!busy} onClick={() => answer(true)}
            className="rounded-xl bg-teal-600 hover:bg-teal-700 py-3 font-bold text-white disabled:opacity-50">{busy === 'yes' ? '…' : 'Yes, it is ours'}</button>
        </div>
      </div>
    </div>
  )
}

/** Settings: the computers allowed in, each with Remove. */
export function PcAccessList() {
  const [list, setList] = useState(null)
  const load = () => api.get('/pc-access/list').then(r => setList(r.data || [])).catch(() => setList(false))
  useEffect(() => { load() }, [])
  if (list === false) return null   // opened from another computer: only the main PC manages this
  return (
    <section className="panel p-4 space-y-2">
      <h3 className="font-bold">💻 Computers allowed to open Adal Keep</h3>
      <p className="text-xs text-slate-500">Other computers (a branch, a laptop) ask once; this PC says Yes or No. This PC and the paired phones are always in.</p>
      {list === null ? <p className="text-sm text-slate-400">…</p>
        : !list.length ? <p className="text-sm text-slate-400">None yet.</p>
        : <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {list.map(p => (
              <li key={p.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-semibold">{p.name}</span>
                  <span className="text-xs text-slate-500">{p.last_ip || p.ip} · last seen {new Date(p.last_seen || p.approved_at).toLocaleString()}</span>
                </span>
                <button type="button" onClick={async () => { if (confirm(`Remove ${p.name}? It will have to ask again.`)) { await api.delete(`/pc-access/${p.id}`); load() } }}
                  className="rounded-lg border border-red-200 px-2.5 py-1 text-xs font-semibold text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-300">Remove</button>
              </li>
            ))}
          </ul>}
    </section>
  )
}
