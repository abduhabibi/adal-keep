import { useEffect, useRef, useState } from 'react'
import api from '../services/api'

/**
 * The run's tab on the PC, live — for a person who is not at the PC (the
 * phone app). Tap the picture to click there; type and press Enter to answer
 * a captcha or a code. Refreshes about once a second.
 */
export default function LiveTab({ runId }) {
  const [src, setSrc] = useState(null)
  const [err, setErr] = useState(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const last = useRef(null)

  useEffect(() => {
    let alive = true, timer = null
    const tick = async () => {
      try {
        const r = await api.get(`/automations/${runId}/screen`, { responseType: 'blob' })
        if (!alive) return
        const url = URL.createObjectURL(r.data)
        if (last.current) URL.revokeObjectURL(last.current)
        last.current = url
        setSrc(url); setErr(null)
      } catch (e) {
        if (alive) setErr(e.response?.status === 404
          ? 'This run\'s tab on the PC was closed. Press ▶ Continue — the run opens it again and it shows here.'
          : 'The PC tab did not answer.')
      }
      if (alive) timer = setTimeout(tick, document.hidden ? 4000 : 900)
    }
    tick()
    return () => { alive = false; clearTimeout(timer); if (last.current) URL.revokeObjectURL(last.current) }
  }, [runId])

  const send = async (body) => {
    setBusy(true)
    try { await api.post(`/automations/${runId}/input`, body) } catch {}
    setBusy(false)
  }
  const tap = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    send({ kind: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height })
  }
  const submit = async (e) => {
    e.preventDefault()
    if (text) await send({ kind: 'type', text })
    await send({ kind: 'key', key: 'Enter' })
    setText('')
  }

  return (
    <div className="rounded-xl border-2 border-indigo-300 dark:border-indigo-700 bg-white dark:bg-slate-950 p-2 space-y-2">
      <p className="text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">📱 The PC's tab, live — tap on it to click there</p>
      {err && !src && <p className="text-xs text-slate-500 p-4 text-center">{err}</p>}
      {src && <img src={src} alt="The run's tab on the PC" onClick={tap} className="w-full rounded-lg border border-slate-200 dark:border-slate-800 cursor-crosshair select-none" draggable={false} />}
      <form onSubmit={submit} className="flex gap-1.5">
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Type here (captcha, code…) — tap the box in the picture first"
          className="flex-1 min-w-0 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2.5 py-2 text-sm" autoCapitalize="off" autoCorrect="off" />
        <button type="submit" disabled={busy} className="rounded-lg bg-indigo-600 text-white text-xs font-semibold px-3 disabled:opacity-60">Type ⏎</button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {[['⌫', { kind: 'key', key: 'Backspace' }], ['Tab', { kind: 'key', key: 'Tab' }], ['▲ Scroll', { kind: 'scroll', dy: -400 }], ['▼ Scroll', { kind: 'scroll', dy: 400 }]].map(([l, b]) => (
          <button key={l} type="button" onClick={() => send(b)} disabled={busy}
            className="rounded-lg border border-slate-300 dark:border-slate-600 px-2.5 py-1 text-xs disabled:opacity-60">{l}</button>
        ))}
      </div>
    </div>
  )
}
