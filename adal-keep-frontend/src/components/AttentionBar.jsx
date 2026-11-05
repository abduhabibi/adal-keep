import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import LiveTab from './LiveTab'

/**
 * What needs a person, as normal notifications in the corner of Adal Keep, each
 * with its X. No window opens for them. A captcha or a code is answered right
 * in the notification (Enter sends it, a wrong one asks again), a question has
 * its answers as buttons, and the run goes on by itself. A click opens that tab
 * (a reCAPTCHA, Save), live, over Adal Keep. X only hides it here: the bell
 * brings it back, and the run keeps waiting.
 * In the phone app each call is also an Android notification, answered from
 * there. With Adal Keep out of sight on a PC, a desktop one tells of it.
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

const phone = () => window.Capacitor?.Plugins?.AdalDiscovery
const keyOf = (c) => `${c.run_id}:${c.at}`
const send = (run, text) => api.post(`/automations/${run}/captcha`, { text })

function Call({ c, onDone, onHide }) {
  const navigate = useNavigate()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const answer = async (value) => {
    if (!String(value).trim()) return
    setBusy(true)
    try { await send(c.run_id, value); setText(''); onDone() }
    catch (er) { toast.error(err(er)) }
    setBusy(false)
  }
  const [live, setLive] = useState(false)
  const open = () => window.__ADAL_CLOUD ? navigate(`/profiles/${c.profile_id}?run=${c.run_id}&t=${Date.now()}`) : setLive(true)
  return (
    <li className="relative space-y-2 rounded-2xl border border-slate-200 bg-white p-3 pr-8 shadow-xl dark:border-slate-700 dark:bg-slate-900">
      <button type="button" aria-label="Hide" onClick={onHide} className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">✕</button>
      <button type="button" onClick={open} className="block w-full text-left">
        <p className="truncate text-xs font-bold">{c.full_name || `Run #${c.run_id}`}</p>
        <p className="text-xs text-slate-600 dark:text-slate-300">{c.title}</p>
      </button>
      {c.asks && c.choices && (
        <div className="flex flex-wrap gap-1.5">
          {c.choices.map(v => <button key={v} type="button" disabled={busy} onClick={() => answer(v)} className="rounded-lg border border-teal-300 px-2 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50 dark:border-teal-700 dark:text-teal-300">{v}</button>)}
        </div>
      )}
      {c.asks && !c.choices && (
        <form onSubmit={(e) => { e.preventDefault(); answer(text) }} className="flex items-stretch gap-1.5">
          {c.image && <img src={c.image} alt="Captcha" className="h-10 rounded border border-slate-200 bg-white" />}
          <input autoFocus value={text} onChange={e => setText(e.target.value)} placeholder={c.label || 'Numbers'} inputMode="numeric" autoComplete="off"
            className="w-24 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          <button disabled={busy || !text.trim()} className="rounded-lg bg-teal-600 px-2.5 text-xs font-bold text-white disabled:opacity-50">{busy ? '…' : 'Send'}</button>
        </form>
      )}
      <span className="flex gap-3">
        <button type="button" onClick={open} className="text-xs font-semibold text-teal-700 hover:underline dark:text-teal-400">Open →</button>
        {c.confirm && <button type="button" onClick={() => api.post(`/automations/${c.run_id}/attention/done`).then(onDone).catch(e => toast.error(err(e)))} className="text-xs font-semibold text-slate-500 hover:underline">Done ✓</button>}
      </span>
      {live && createPortal(<LiveTab runId={c.run_id} startFull onClose={() => setLive(false)} />, document.body)}
    </li>
  )
}

export default function AttentionBar() {
  const [calls, setCalls] = useState([])
  const [hidden, setHidden] = useState(() => new Set())
  const seen = useRef(null)
  const load = () => api.get('/automations/attention').then(r => {
    const list = r.data || []
    const fresh = seen.current ? list.filter(c => !seen.current.has(keyOf(c))) : []
    if (fresh.length && !here()) beep()
    // Out of sight: the phone's or the PC's own notification.
    for (const c of fresh) {
      if (!document.hidden) continue
      const title = c.full_name || 'Adal Keep'
      if (phone()) phone().notifyCall?.({ run: c.run_id, title, body: c.title, image: c.image || undefined, asks: !!c.asks, label: c.label, choices: c.choices || undefined })
      else if (window.Notification?.permission === 'granted') {
        const n = new Notification(title, { body: c.title, tag: String(c.run_id), silent: true })
        n.onclick = () => { window.focus(); n.close() }
      }
    }
    if (seen.current) {
      const now = new Set(list.map(c => c.run_id))
      for (const k of seen.current) { const run = Number(k.split(':')[0]); if (!now.has(run)) phone()?.cancelCall?.({ run }) }
    }
    if (list.length && window.Notification?.permission === 'default' && !phone()) Notification.requestPermission().catch(() => {})
    seen.current = new Set(list.map(keyOf))
    setCalls(list)
  }).catch(() => {})
  useEffect(() => {
    load()
    const t = setInterval(load, window.__ADAL_CLOUD ? 6000 : 3000)
    let off = null, alive = true, heard = null
    // At once from the PC, not at the next look.
    if (window.__ADAL_CLOUD) import('../cloud/live.js').then(L => { if (alive) off = L.onLive(m => { if (m.t === 'ring') load() }) })
    const p = phone()
    if (p) {
      p.startListening?.().catch?.(() => {})
      heard = p.addListener?.('callReply', ({ run, text }) => send(run, text).then(load).catch(e => toast.error(err(e))))
    }
    return () => { alive = false; clearInterval(t); off?.(); Promise.resolve(heard).then(h => h?.remove?.()) }
  }, [])
  const shown = calls.filter(c => !hidden.has(keyOf(c)))
  if (!calls.length) return null
  const hide = (c) => { setHidden(h => new Set(h).add(keyOf(c))); phone()?.cancelCall?.({ run: c.run_id }) }
  return (
    <>
      {shown.length > 0 && (
        <ul className="fixed right-3 top-3 z-[70] max-h-[calc(100vh-1.5rem)] w-80 max-w-[calc(100vw-1.5rem)] space-y-2 overflow-y-auto">
          {shown.map(c => <Call key={keyOf(c)} c={c} onDone={load} onHide={() => hide(c)} />)}
        </ul>
      )}
      {shown.length < calls.length && (
        <button type="button" onClick={() => setHidden(new Set())} title="Show the hidden notifications"
          className="fixed bottom-3 left-3 z-[70] flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-bold shadow-lg dark:border-slate-700 dark:bg-slate-900">
          🔔 <span className="rounded-full bg-red-500 px-1.5 text-xs text-white">{calls.length - shown.length}</span>
        </button>
      )}
    </>
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
