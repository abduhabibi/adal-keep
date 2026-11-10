import { useEffect, useState } from 'react'
import api from '../services/api'

/**
 * Opened from another computer (a branch PC, a laptop): the main PC lets in
 * only computers someone there said "Yes" to. This computer is named, asks,
 * and waits; once the main PC answers Yes, Adal Keep opens. Asked once —
 * the key stays in this browser.
 */
export default function PcAccessGate() {
  const [state, setState] = useState('none')
  const [name, setName] = useState(() => { try { return localStorage.getItem('adal_pc_name') || '' } catch { return '' } })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [acct, setAcct] = useState({ username: '', password: '' })
  const [way, setWay] = useState('account') // the main PC's account (in at once) · or ask for a Yes

  const check = () => api.get('/pc-access/status').then(r => {
    setState(r.data.state)
    if (r.data.state === 'approved') location.reload()
  }).catch(() => {})
  useEffect(() => { check() }, [])
  useEffect(() => {
    if (state !== 'waiting') return
    const t = setInterval(check, 3000)
    return () => clearInterval(t)
  }, [state])

  const ask = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      try { localStorage.setItem('adal_pc_name', name) } catch {}
      await api.post('/pc-access/request', { name: name.trim() || 'A computer' })
      setState('waiting')
    } catch (er) { setError(er.response?.data?.error || er.message) }
    setBusy(false)
  }

  // Signed in with the main PC's own account: in at once.
  const signIn = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      try { localStorage.setItem('adal_pc_name', name) } catch {}
      await api.post('/pc-access/signin', { ...acct, name: name.trim() || 'A computer' })
      location.reload()
    } catch (er) { setError(er.response?.data?.error || er.message); setBusy(false) }
  }
  const asking = state === 'none' || state === 'denied' || state === 'removed'
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-800 p-6 shadow-xl text-center space-y-4 animate-fade-up">
        <div className="text-5xl">{state === 'waiting' ? '⏳' : '🔐'}</div>
        {asking && way === 'account' ? (
          <form onSubmit={signIn} className="space-y-3">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Sign in to the main PC</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">The same username and password as on the main PC: this computer opens all its data at once.</p>
            <input value={acct.username} onChange={e => setAcct(a => ({ ...a, username: e.target.value }))} autoFocus required autoComplete="username"
              placeholder="Username (or phone)" className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm" />
            <input value={acct.password} onChange={e => setAcct(a => ({ ...a, password: e.target.value }))} type="password" required autoComplete="current-password"
              placeholder="Password" className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm" />
            <input value={name} onChange={e => setName(e.target.value)} maxLength={60}
              placeholder="This computer's name (optional) — e.g. Branch 2 reception"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm" />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button disabled={busy || !acct.username || !acct.password} className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 py-3 font-bold text-white disabled:opacity-50">
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            <button type="button" onClick={() => { setWay('ask'); setError('') }} className="text-xs text-slate-500 hover:underline">No account? Ask the main PC instead</button>
          </form>
        ) : asking ? (
          <form onSubmit={ask} className="space-y-3">
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Ask the main PC to let this computer in</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              {state === 'denied' ? 'The main PC said No. Ask again if that was a mistake.'
                : state === 'removed' ? 'This computer was taken off the main PC\'s list. Ask again to come back.'
                : 'Adal Keep\'s profiles, passports and passwords open only on computers the main PC said "Yes" to. You ask once.'}
            </p>
            <input value={name} onChange={e => setName(e.target.value)} maxLength={60} autoFocus required
              placeholder="This computer's name — e.g. Branch 2 reception"
              className="w-full rounded-xl border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-3 py-2.5 text-sm" />
            {error && <p className="text-sm text-red-600">{error}</p>}
            <button disabled={busy || !name.trim()} className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 py-3 font-bold text-white disabled:opacity-50">
              {busy ? 'Asking…' : 'Ask the main PC'}
            </button>
            <button type="button" onClick={() => { setWay('account'); setError('') }} className="text-xs text-slate-500 hover:underline">Sign in with the main PC's account instead</button>
          </form>
        ) : (
          <>
            <h1 className="text-xl font-bold text-slate-900 dark:text-white">Waiting for the main PC</h1>
            <p className="text-sm text-slate-500 dark:text-slate-400">
              At the main PC, a box asks whether <b>{name || 'this computer'}</b> may open Adal Keep. Once someone there says Yes, this opens by itself.
            </p>
            <div className="mx-auto h-1.5 w-40 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"><div className="h-full w-1/3 animate-pulse rounded-full bg-teal-500" /></div>
          </>
        )}
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
