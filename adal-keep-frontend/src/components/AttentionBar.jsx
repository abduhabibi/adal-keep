import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'

/**
 * The notification bell: a small button in the corner of Adal Keep while
 * something needs a person, and nothing otherwise. No window opens for it. It
 * opens by itself only for a captcha, the one call answered right here. A picture captcha shows here with an input: the typed
 * numbers go into the tab and the run finishes by itself, and the tab stays
 * signed in for the next runs. Anything else (a reCAPTCHA, a code, Save) has
 * Open, which brings that tab forward. The PC beeps by itself; another computer
 * beeps here.
 */
const err = (e) => e?.response?.data?.error || e.message
const here = () => ['localhost', '127.0.0.1'].includes(location.hostname)

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)()
    const o = ctx.createOscillator(), g = ctx.createGain()
    o.frequency.value = 1000; o.connect(g); g.connect(ctx.destination)
    g.gain.setValueAtTime(0.0001, ctx.currentTime)
    g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18)
    o.start(); o.stop(ctx.currentTime + 0.2)
    setTimeout(() => ctx.close(), 500)
  } catch {}
}

function Call({ c, onDone }) {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const send = async (e) => {
    e.preventDefault()
    if (!text.trim()) return
    setBusy(true)
    try { await api.post(`/automations/${c.run_id}/captcha`, { text }); setText(''); onDone() }
    catch (er) { toast.error(err(er)) }
    setBusy(false)
  }
  const open = async () => {
    if (window.__ADAL_CLOUD) return navigate(`/profiles/${c.profile_id}?run=${c.run_id}&t=${Date.now()}`)
    try { await api.post(`/automations/${c.run_id}/show`) } catch (er) { toast.error(err(er)) }
  }
  return (
    <li className="space-y-1.5 px-3 py-2.5">
      <p className="truncate text-xs font-bold">{c.full_name || `Run #${c.run_id}`}</p>
      <p className="text-xs text-slate-600 dark:text-slate-300">{c.title}</p>
      {c.image && (
        <form onSubmit={send} className="flex items-stretch gap-1.5">
          <img src={c.image} alt="Captcha" className="h-10 rounded border border-slate-200 bg-white" />
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Numbers" inputMode="numeric" autoComplete="off"
            className="w-24 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          <button disabled={busy || !text.trim()} className="rounded-lg bg-teal-600 px-2.5 text-xs font-bold text-white disabled:opacity-50">{busy ? '…' : 'Send'}</button>
        </form>
      )}
      <button type="button" onClick={open} className="text-xs font-semibold text-teal-700 hover:underline dark:text-teal-400">Open →</button>
    </li>
  )
}

export default function AttentionBar() {
  const [calls, setCalls] = useState([])
  const [open, setOpen] = useState(false)
  const shut = useRef(false)   // closed by hand: stays closed
  const seen = useRef(null)
  const load = () => api.get('/automations/attention').then(r => {
    const list = r.data || []
    const keys = list.map(c => `${c.run_id}:${c.at}`)
    if (seen.current && !here() && keys.some(k => !seen.current.has(k))) beep()
    seen.current = new Set(keys)
    setCalls(list)
    if (!list.length) shut.current = false
    else if (list.some(c => c.image) && !shut.current) setOpen(true)
  }).catch(() => {})
  useEffect(() => {
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [])
  if (!calls.length) return null
  const toggle = () => setOpen(o => { shut.current = o; return !o })
  return (
    <div className="fixed bottom-3 left-3 z-[70] flex max-w-[calc(100vw-1.5rem)] flex-col items-start gap-2">
      {open && (
        <ul className="max-h-[45vh] w-72 max-w-full divide-y divide-slate-100 overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-xl dark:divide-slate-800 dark:border-slate-700 dark:bg-slate-900">
          {calls.map(c => <Call key={c.run_id} c={c} onDone={load} />)}
        </ul>
      )}
      <button type="button" onClick={toggle} title={`${calls.length} need${calls.length === 1 ? 's' : ''} you`}
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-bold shadow-lg dark:border-slate-700 dark:bg-slate-900">
        🔔 <span className="rounded-full bg-red-500 px-1.5 text-xs text-white">{calls.length}</span>
      </button>
    </div>
  )
}

/** Settings: opening with the PC needs a yes here; the browser for a person's own use. */
export function StartupCard() {
  const [on, setOn] = useState(false)
  useEffect(() => { api.get('/main-pc/open-at-start').then(r => setOn(!!r.data.on)).catch(() => {}) }, [])
  const set = async (v) => {
    try { setOn((await api.post('/main-pc/open-at-start', { on: v })).data.on) } catch (e) { toast.error(err(e)) }
  }
  return (
    <section className="panel space-y-3 p-4">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={on} onChange={e => set(e.target.checked)} /> Open Adal Keep when this PC starts
      </label>
      <p className="text-xs text-slate-500">Off: the agents and WhatsApp still work in the background, and the window opens only from its icon.</p>
      <button type="button" className="rounded-lg border border-teal-300 px-3 py-1.5 text-sm font-semibold text-teal-700 hover:bg-teal-50 dark:border-teal-700 dark:text-teal-300 dark:hover:bg-teal-900/20"
        onClick={() => api.post('/browser/open').catch(e => toast.error(err(e)))}>🌐 Open Adal Browser</button>
    </section>
  )
}
