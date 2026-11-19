import { useEffect, useState } from 'react'
import api, { joinInfo, rememberJoin, forgetJoin } from '../services/api'

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
  // Coming back by itself (a Companion that joined before): no form, just a moment.
  const [quiet, setQuiet] = useState(() => !!joinInfo().number)

  const send = async (n, { auto = false } = {}) => {
    setBusy(true); setError('')
    let name = ''
    try { name = localStorage.getItem('adal_pc_name') || '' } catch {}
    const j = joinInfo()
    try {
      const { data } = await api.post('/pc-access/number', { number: n, name: name || 'Adal Companion PC', device: j.device || undefined, cid: j.cid || undefined })
      rememberJoin({ ...j, number: n }, data?.key)
      if (location.hash) history.replaceState(history.state, '', location.pathname + location.search)
      location.reload()
    } catch (er) {
      if (er.response?.data?.suspended) { window.dispatchEvent(new Event('adal-suspended')); return }
      // The main PC not answering for a moment (restarting, an update): tried again, nothing typed.
      if (auto && (!er.response || er.response.status >= 500)) { setTimeout(() => send(n, { auto: true }), 5000); return }
      // A number that is not this main PC's any more: typed again.
      if (er.response?.status === 403) forgetJoin()
      setQuiet(false); setNumber(n); setError(er.response?.data?.error || er.message); setBusy(false)
    }
  }
  useEffect(() => {
    api.get('/pc-access/status').then(r => {
      if (r.data.state === 'approved') return location.reload()
      if (r.data.state === 'suspended') return window.dispatchEvent(new Event('adal-suspended'))
      // Taken off the main PC's list there: typed again, never by itself.
      const n = r.data.state === 'removed' ? '' : (joinInfo().number || '').replace(/\D/g, '')
      if (n.length >= 5) send(n, { auto: true })
      else setQuiet(false)
    }).catch(() => {
      const n = (joinInfo().number || '').replace(/\D/g, '')
      if (n.length >= 5) send(n, { auto: true }); else setQuiet(false)
    })
  }, [])

  if (quiet) return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900" data-reconnecting="">
      <div className="w-14 h-14 rounded-2xl overflow-hidden shadow-lg animate-pulse"><img src="/adal-logo.png" alt="Adal" className="h-full w-full object-cover" draggable={false} /></div>
    </div>
  )
  const signIn = (e) => { e.preventDefault(); send(number) }
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-800 p-6 shadow-xl text-center space-y-4 animate-fade-up">
        <div className="text-5xl">🔐</div>
        <form onSubmit={signIn} className="space-y-3">
          <h1 className="text-xl font-bold text-slate-900 dark:text-white">PC number</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">The main PC's number (5 digits, in its Settings → Main PC, e.g. 47040).</p>
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

/** A device suspended by the main PC: nothing of the agency opens here until it is allowed again. */
export function SuspendedScreen() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white dark:bg-slate-800 p-6 shadow-xl text-center space-y-3" data-suspended="">
        <div className="text-5xl">⛔</div>
        <h1 className="text-xl font-bold text-slate-900 dark:text-white">Suspended by the main PC</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">This device can no longer open the agency's Adal Keep: the main PC suspended it. Ask at the main PC: Settings → Agency → Connected devices → Allow again.</p>
        <button type="button" onClick={() => location.reload()} className="w-full rounded-xl bg-teal-600 hover:bg-teal-700 py-3 font-bold text-white">Try again</button>
      </div>
    </div>
  )
}

/**
 * Settings → Agency, on the main PC: every connected device — the Adal
 * Companions (let in with this PC's number; their online account goes with
 * them) and the phones — each with Suspend / Allow again. A suspended one is
 * cut off at once: no calls to this PC, no online copy.
 */
export function ConnectedDevices() {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState('')
  const load = () => api.get('/pc-access/devices').then(r => setData(r.data)).catch(() => setData(false))
  useEffect(() => { load(); const t = setInterval(load, 20000); return () => clearInterval(t) }, [])
  if (data === false || !data) return null   // only the main PC itself manages its devices
  const toggle = async (d) => {
    const on = !d.suspended
    if (on && !window.confirm(`Suspend "${d.name}"? It is cut off at once: it cannot open this PC's Adal Keep or the online copy until you allow it again.`)) return
    setBusy(d.pc || d.device)
    try { await api.post('/pc-access/devices/suspend', { pc: d.pc || undefined, device: d.device || undefined, suspended: on }) }
    catch (e) { window.alert(e.response?.data?.error || e.message) }
    setBusy(''); load()
  }
  const list = data.devices || []
  return (
    <section className="panel p-4 space-y-2" data-connected-devices="">
      <h3 className="font-bold">Connected devices</h3>
      {data.cloud_error && <p className="text-xs text-amber-700">Phones: {data.cloud_error}</p>}
      {!list.length ? <p className="text-sm text-slate-400">None yet.</p>
        : <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {list.map(d => (
              <li key={d.pc || d.device} className="flex items-center gap-2 py-2 text-sm">
                <span>{d.kind === 'phone' ? '📱' : '💻'}</span>
                <span className="min-w-0 flex-1">
                  <span className={`block truncate font-semibold ${d.suspended ? 'line-through text-slate-400' : ''}`}>{d.name}</span>
                  <span className="text-xs text-slate-500">{d.kind === 'phone' ? 'Phone' : 'Companion'}{d.ip ? ` · ${d.ip}` : ''}{d.last_seen ? ` · last seen ${new Date(d.last_seen).toLocaleString()}` : ''}{d.suspended ? ' · suspended' : ''}</span>
                </span>
                <button type="button" disabled={busy === (d.pc || d.device)} onClick={() => toggle(d)}
                  className={`rounded-lg border px-2.5 py-1 text-xs font-semibold disabled:opacity-50 ${d.suspended ? 'border-teal-300 text-teal-700 dark:text-teal-300' : 'border-red-200 text-red-700 dark:border-red-800 dark:text-red-300'}`}>
                  {d.suspended ? 'Allow again' : 'Suspend'}</button>
              </li>
            ))}
          </ul>}
    </section>
  )
}
