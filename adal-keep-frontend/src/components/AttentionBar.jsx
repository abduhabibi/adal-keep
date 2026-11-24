import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../services/api'
import { phoneCloud } from '../lib/phoneMode'
import { markDone, DONE_LABEL } from '../lib/markDone'
import { lazyOrNothing } from '../lib/reloadGuard'
// The live view's code (30 kB) only when a notification is opened: not part of every start.
// (After an update its old file is gone: the page reloads with the new files.)
const LiveTab = lazy(lazyOrNothing(() => import('./LiveTab'), 'the live view\'s file did not load'))

/**
 * What needs a person, as normal notifications in the corner of Adal Keep, each
 * with its X. No window opens for them. A captcha or a code is answered right
 * in the notification (Enter sends it, a wrong one asks again), a question has
 * its answers as buttons, and the run goes on by itself. A click opens that tab
 * (a reCAPTCHA, Save), live, over Adal Keep. X removes it (it does not come
 * back in the 🔔); the run itself keeps waiting on its profile.
 * In the phone app each call is also an Android notification, answered from
 * there. With Adal Keep out of sight on a PC, a desktop one tells of it.
 */
const err = (e) => e?.response?.data?.error || e.message
const here = () => ['localhost', '127.0.0.1'].includes(location.hostname)

// One beep, however many notices come together (2026-11-23: a run's call and its task each rang, and
// every new run rang again — "weird noises"). Another one only after 20 s.
let lastBeep = 0
export function beep() {
  if (Date.now() - lastBeep < 20000) return
  lastBeep = Date.now()
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

// Short words for each kind of step (backend attention.js kindOf).
const KIND = { captcha: 'Captcha', tick: 'Tick the box', slot: 'Pick a time', code: 'Code', choice: 'Choose', signin: 'Sign in', confirm: 'Check and save', answer: 'Answer', look: 'Look' }
const left = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}` }

/** One human step of a run: a task, answered here or in its live browser (one click). */
function Task({ c, onDone, onOpen }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const answer = async (value) => {
    if (!String(value).trim()) return
    setBusy(true)
    try { await send(c.run_id, value); setText(''); onDone() }
    catch (er) { toast.error(err(er)) }
    setBusy(false)
  }
  // Numbers only, except a code in letters (Tasheer's captcha: "Letters in the picture").
  const digitsOnly = /number|code|captcha|^$/i.test(c.label || '') && !/letter/i.test(c.label || '')
  // A run waiting for its "✔️ … saved": the step is done and she moves on (lib/markDone, 5 s Undo).
  const doneWord = c.run_id > 0 && c.run_status === 'paused' && DONE_LABEL[c.reason]
  const done = async () => {
    setBusy(true)
    const r = await markDone({ runId: c.run_id, profileId: c.profile_id, label: doneWord })
    if (r) { api.post(`/automations/${c.run_id}/attention/done`).catch(() => {}); onDone() }
    setBusy(false)
  }
  return (
    <li className="space-y-1.5 border-t border-slate-100 pt-2 first:border-0 first:pt-0 dark:border-slate-800">
      <button type="button" onClick={onOpen} className="flex w-full items-baseline gap-2 text-left">
        <span className="shrink-0 rounded bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-300">{KIND[c.kind] || 'Task'}</span>
        <span className="min-w-0 flex-1 truncate text-xs text-slate-700 dark:text-slate-200">{c.title}</span>
        {c.expires_in_ms > 0 && <span className="shrink-0 text-[10px] tabular-nums text-slate-400" title="Then the run waits, paused">{left(c.expires_in_ms)}</span>}
      </button>
      {c.asks && c.choices && (
        <div className="flex flex-wrap gap-1.5">
          {c.choices.map(v => <button key={v} type="button" disabled={busy} onClick={() => answer(v)} className="rounded-lg border border-teal-300 px-2 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50 disabled:opacity-50 dark:border-teal-700 dark:text-teal-300">{v}</button>)}
        </div>
      )}
      {c.asks && !c.choices && (
        <form onSubmit={(e) => { e.preventDefault(); answer(text) }} className="flex items-stretch gap-1.5">
          {c.image && <img src={c.image} alt="Captcha" className="h-10 rounded border border-slate-200 bg-white" />}
          <input autoFocus value={text} onChange={e => setText(digitsOnly ? e.target.value.replace(/[^0-9]/g, "") : e.target.value)} placeholder={c.label || 'Numbers'} inputMode={digitsOnly ? 'numeric' : 'text'} autoComplete="off"
            className="w-24 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm dark:border-slate-600 dark:bg-slate-800" />
          <button disabled={busy || !text.trim()} className="rounded-lg bg-teal-600 px-2.5 text-xs font-bold text-white disabled:opacity-50">{busy ? '…' : 'Send'}</button>
        </form>
      )}
      <span className="flex gap-3">
        {c.run_id > 0 && <button type="button" onClick={onOpen} className="text-xs font-semibold text-teal-700 hover:underline dark:text-teal-400">Open browser →</button>}
        {doneWord && <button type="button" disabled={busy} onClick={done} className="rounded-lg bg-emerald-600 px-2 py-0.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50">{doneWord}</button>}
        {c.confirm && !doneWord && <button type="button" onClick={() => api.post(`/automations/${c.run_id}/attention/done`).then(onDone).catch(e => toast.error(err(e)))} className="text-xs font-semibold text-slate-500 hover:underline">Done ✓</button>}
      </span>
    </li>
  )
}

/** A run's human steps together: who it is for, then one task per step. */
function RunTasks({ run, tasks, onDone, onHide }) {
  const navigate = useNavigate()
  const [live, setLive] = useState(false)
  const first = tasks[0]
  const open = () => run <= 0 ? null : window.__ADAL_CLOUD ? navigate(`/profiles/${first.profile_id}?run=${run}&t=${Date.now()}`) : setLive(true)
  return (
    <li className="relative space-y-2 rounded-2xl border border-slate-200 bg-white p-3 pr-8 shadow-xl dark:border-slate-700 dark:bg-slate-900">
      <button type="button" aria-label="Hide" onClick={onHide} className="absolute right-1.5 top-1.5 flex h-6 w-6 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800">✕</button>
      <p className="truncate text-xs font-bold">{first.full_name || `Run #${run}`}{tasks.length > 1 ? ` · ${tasks.length} steps` : ''}</p>
      <ul className="space-y-2">{tasks.map(c => <Task key={keyOf(c)} c={c} onDone={onDone} onOpen={open} />)}</ul>
      {live && createPortal(<Suspense fallback={null}><LiveTab runId={run} startFull onClose={() => setLive(false)} /></Suspense>, document.body)}
    </li>
  )
}

export default function AttentionBar() {
  const [calls, setCalls] = useState([])
  // Removed with X: kept on this PC so they do not come back.
  const [hidden, setHidden] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('adal-calls-removed') || '[]')) } catch { return new Set() } })
  useEffect(() => { try { localStorage.setItem('adal-calls-removed', JSON.stringify([...hidden].slice(-300))) } catch {} }, [hidden])
  const seen = useRef(null)
  const runsHeard = useRef(new Set())   // one sound and one notice per run, not per step
  const load = () => api.get('/automations/attention').then(r => {
    // A phone does not get what goes to the PC first (an Enjaz captcha: 30 s) until then.
    const onPhone = !!phone() || phoneCloud()
    const list = (r.data || []).filter(c => !onPhone || !(c.phone_wait_ms > 0))
    const fresh = seen.current ? list.filter(c => !seen.current.has(keyOf(c))) : []
    const newRuns = fresh.filter(c => !runsHeard.current.has(c.run_id))
    if (newRuns.length) beep()
    for (const c of fresh) {
      const firstOfRun = !runsHeard.current.has(c.run_id)
      runsHeard.current.add(c.run_id)
      const title = c.full_name || 'Adal Keep'
      // The phone app: each step is its own Android notification, answered from there.
      if (phone() && document.hidden) { phone().notifyCall?.({ run: c.run_id, at: c.at || 0, profile: c.profile_id || 0, title, body: c.title, image: c.image || undefined, asks: !!c.asks, label: c.label, choices: c.choices || undefined }); continue }
      if (!firstOfRun || onPhone || window.Notification?.permission !== 'granted') continue
      // On the PC: one desktop notice for a run (with the captcha's picture when it starts with one).
      if (c.asks && c.image) {
        const n = new Notification(`${title}: ${c.title}`, { body: 'Type it in Adal Keep (Tasks, top right).', image: c.image, icon: c.image, tag: `run-${c.run_id}`, requireInteraction: true })
        n.onclick = () => { window.focus(); n.close() }
      } else if (document.hidden) {
        const n = new Notification(title, { body: c.title, tag: `run-${c.run_id}`, silent: true })
        n.onclick = () => { window.focus(); n.close() }
      }
    }
    const now = new Set(list.map(c => c.run_id))
    for (const run of runsHeard.current) if (!now.has(run)) runsHeard.current.delete(run)
    if (seen.current) {
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
  if (!shown.length) return null
  const groups = new Map()
  for (const c of shown) groups.set(c.run_id, [...(groups.get(c.run_id) || []), c])
  const hide = (tasks) => { setHidden(h => { const n = new Set(h); for (const c of tasks) n.add(keyOf(c)); return n }); phone()?.cancelCall?.({ run: tasks[0].run_id }) }
  return (
    <ul className="fixed end-3 top-3 z-[70] max-h-[calc(100vh-1.5rem)] w-80 max-w-[calc(100vw-1.5rem)] space-y-2 overflow-y-auto">
      {[...groups.entries()].map(([run, tasks]) => <RunTasks key={run} run={run} tasks={tasks.sort((a, b) => (a.step || 0) - (b.step || 0))} onDone={load} onHide={() => hide(tasks)} />)}
    </ul>
  )
}

/** Quit Adal Keep on the main PC: the server, the agents, WhatsApp, the Companions' connection. */
async function quit() {
  if (!window.confirm('Quit Adal Keep?\n\nThe server, the robots and WhatsApp stop on this PC, and the Companions and phones cannot connect until Adal Keep is opened again from its icon.')) return
  try { await api.post('/app/quit') } catch {}
  toast.success('Adal Keep is stopping. Open it again from its icon.')
}

export function StartupCard() {
  // (No "Open Adal Keep when this PC starts" any more: the window opens only from its icon.)
  if (!(here() && /Windows/i.test(navigator.userAgent) && import.meta.env.VITE_ADMIN !== '1')) return null
  return (
    <section className="panel space-y-3 p-4">
      {/* Quit: out of the sidebar (2026-11-21, Browsers took its place); here, quiet, after a Yes. */}
      {(
        <button type="button" onClick={quit} className="text-xs font-semibold text-slate-500 hover:text-rose-600 hover:underline">Quit Adal Keep on this PC…</button>
      )}
    </section>
  )
}

/**
 * Settings: "Remote support by Adal" (default ON). Off does what Adal Disconnect
 * did: Adal can no longer reach this PC and Adal Keep stops repairing it. On
 * puts it back. Main: this PC's server. Companion window: the Companion on this
 * PC (127.0.0.1:47810). Any other device (phone, other browser): not shown.
 * Every change is written to adal-support.log on the PC.
 */
const COMPANION_SUPPORT = 'http://127.0.0.1:47810/support'
export function SupportCard() {
  const [state, setState] = useState(null) // { on, where: 'main' | 'companion' }
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    ;(async () => {
      const m = await api.get('/main-pc/support').then(r => r.data).catch(() => null)
      if (m?.on_this_pc) { if (live) setState({ on: !!m.on, where: 'main' }); return }
      const c = await fetch(COMPANION_SUPPORT, { signal: AbortSignal.timeout(4000) }).then(r => (r.ok ? r.json() : null)).catch(() => null)
      if (c && live) setState({ on: !!c.on, where: 'companion' })
    })()
    return () => { live = false }
  }, [])
  if (!state) return null
  const set = async (v) => {
    setBusy(true)
    try {
      if (state.where === 'main') setState({ ...state, on: !!(await api.post('/main-pc/support', { on: v })).data.on })
      else {
        const r = await fetch(COMPANION_SUPPORT, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Adal': '1' }, body: JSON.stringify({ on: v }), signal: AbortSignal.timeout(8000) })
        if (!r.ok) throw new Error('The Adal Keep Companion on this PC did not answer')
        setState({ ...state, on: !!(await r.json()).on })
      }
    } catch (e) { toast.error(err(e)) }
    setBusy(false)
  }
  return (
    <section className="panel space-y-1 p-4">
      <label className="flex items-center gap-2 text-sm font-semibold">
        <input type="checkbox" checked={state.on} disabled={busy} onChange={e => set(e.target.checked)} /> Remote support by Adal
      </label>
      <p className="text-xs text-slate-500">
        {state.on ? 'Adal can reach this PC to help (key only; every login is written down on this PC).' : 'Off: Adal cannot reach this PC.'}
      </p>
    </section>
  )
}
