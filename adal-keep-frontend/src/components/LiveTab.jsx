import { useEffect, useRef, useState } from 'react'
import api from '../services/api'

/**
 * The run's tab on the PC, live, and driven from here: an address bar,
 * back / forward / reload, tap to click, swipe or wheel to scroll, typing.
 * In the phone app (and wherever the live link is up) the PC streams the tab
 * as it changes (Supabase Realtime); elsewhere it is asked for a picture
 * about once a second.
 */
export default function LiveTab({ runId }) {
  const [src, setSrc] = useState(null)
  const [meta, setMeta] = useState({ url: '', title: '' })
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState(null)
  const [text, setText] = useState('')
  const [full, setFull] = useState(false)
  const [mode, setMode] = useState('…')
  const [fps, setFps] = useState(0)
  const last = useRef(null)
  const live = useRef(null)          // the live link (cloud/live.js) when it is up
  const frames = useRef([])
  const drag = useRef(null)

  const show = (url) => {
    if (last.current) URL.revokeObjectURL(last.current)
    last.current = url
    setSrc(url); setErr(null)
    const now = Date.now()
    frames.current = [...frames.current.filter(t => now - t < 3000), now]
    setFps(Math.round(frames.current.length / 3))
  }

  useEffect(() => {
    let alive = true, timer = null, off = null, renew = null
    const start = async () => {
      // Live stream when this is the phone app / an online window with the link up.
      if (window.__ADAL_CLOUD) {
        const L = await import('../cloud/live.js')
        if (L.liveReady()) {
          live.current = L
          setMode('live')
          off = L.onLive((m) => {
            if (m.t !== 'frame' || Number(m.run) !== Number(runId) || !alive) return
            if (m.gone) { setErr('This run\'s tab on the PC was closed. Press ▶ Continue — the run opens it again and it shows here.'); return }
            const bin = atob(m.img), bytes = new Uint8Array(bin.length)
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
            show(URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })))
            setMeta({ url: m.url || '', title: m.title || '' })
          })
          const watch = () => L.sendLive({ t: 'watch', run: runId })
          watch()
          renew = setInterval(watch, 8000)
          return
        }
      }
      // Otherwise: a picture about once a second.
      setMode('pictures')
      const tick = async () => {
        try {
          const r = await api.get(`/automations/${runId}/screen`, { responseType: 'blob' })
          if (!alive) return
          show(URL.createObjectURL(r.data))
          const u = r.headers?.['x-tab-url']
          if (u) setMeta(m => ({ ...m, url: decodeURI(u) }))
        } catch (e) {
          if (alive) setErr(e.response?.status === 404
            ? 'This run\'s tab on the PC was closed. Press ▶ Continue — the run opens it again and it shows here.'
            : 'The PC tab did not answer.')
        }
        if (alive) timer = setTimeout(tick, document.hidden ? 4000 : 800)
      }
      tick()
    }
    start()
    return () => { alive = false; clearTimeout(timer); clearInterval(renew); off?.(); if (last.current) URL.revokeObjectURL(last.current) }
  }, [runId])

  useEffect(() => { if (!editing) setAddress(meta.url) }, [meta.url, editing])

  const send = async (body) => {
    if (live.current) return live.current.sendLive({ t: 'input', run: runId, ...body })
    try { await api.post(`/automations/${runId}/input`, body) } catch {}
  }

  // Tap = click there; drag = scroll.
  const point = (e) => { const t = e.touches?.[0] || e.changedTouches?.[0] || e; return { x: t.clientX, y: t.clientY } }
  const down = (e) => { drag.current = { ...point(e), moved: false } }
  const move = (e) => {
    if (!drag.current) return
    const p = point(e), dy = drag.current.y - p.y, dx = drag.current.x - p.x
    if (Math.abs(dy) > 25 || Math.abs(dx) > 25) {
      const r = e.currentTarget.getBoundingClientRect()
      const k = 1000 / r.width   // picture px → page px (roughly)
      send({ kind: 'scroll', dy: Math.round(dy * k * 1.3), dx: Math.round(dx * k * 1.3) })
      drag.current = { ...p, moved: true }
    }
  }
  const up = (e) => {
    const d = drag.current; drag.current = null
    if (!d || d.moved) return
    const r = e.currentTarget.getBoundingClientRect(), p = point(e)
    send({ kind: 'click', x: (p.x - r.left) / r.width, y: (p.y - r.top) / r.height })
  }
  const wheel = (e) => { send({ kind: 'scroll', dy: Math.round(e.deltaY), dx: Math.round(e.deltaX) }) }

  const submit = async (e) => {
    e.preventDefault()
    if (text) await send({ kind: 'type', text })
    await send({ kind: 'key', key: 'Enter' })
    setText('')
  }
  const go = (e) => { e.preventDefault(); setEditing(false); if (address.trim()) send({ kind: 'nav', url: address.trim() }) }

  const btn = 'shrink-0 rounded-lg border border-slate-300 dark:border-slate-600 px-2 py-1.5 text-xs font-semibold active:bg-slate-100 dark:active:bg-slate-800'
  return (
    <div className={full
      ? 'fixed inset-0 z-[90] bg-white dark:bg-slate-950 p-2 flex flex-col gap-2'
      : 'rounded-xl border-2 border-indigo-300 dark:border-indigo-700 bg-white dark:bg-slate-950 p-2 space-y-2'}>
      <div className="flex items-center gap-1.5">
        <button type="button" className={btn} onClick={() => send({ kind: 'back' })} title="Back">←</button>
        <button type="button" className={btn} onClick={() => send({ kind: 'forward' })} title="Forward">→</button>
        <button type="button" className={btn} onClick={() => send({ kind: 'reload' })} title="Reload">↻</button>
        <form onSubmit={go} className="flex-1 min-w-0">
          <input value={address} onFocus={() => setEditing(true)} onBlur={() => setTimeout(() => setEditing(false), 200)}
            onChange={(e) => setAddress(e.target.value)} inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 px-2.5 py-1.5 text-xs font-mono truncate" />
        </form>
        <button type="button" className={btn} onClick={() => setFull(f => !f)} title={full ? 'Smaller' : 'Full screen'}>{full ? '✕' : '⛶'}</button>
      </div>
      <p className="text-[10px] text-slate-500 flex justify-between gap-2">
        <span className="truncate">{meta.title || 'The PC\'s tab — tap to click, swipe to scroll'}</span>
        <span className="shrink-0">{mode === 'live' ? `⚡ live · ${fps}/s` : mode === 'pictures' ? '🖼 every second' : '…'}</span>
      </p>
      {err && !src && <p className="text-xs text-slate-500 p-4 text-center">{err}</p>}
      {src && (
        <div className={full ? 'flex-1 min-h-0 overflow-auto flex items-start justify-center' : ''}>
          <img src={src} alt="The run's tab on the PC" draggable={false}
            onMouseDown={down} onMouseMove={(e) => e.buttons && move(e)} onMouseUp={up}
            onTouchStart={down} onTouchMove={move} onTouchEnd={up} onWheel={wheel}
            className={`${full ? 'max-h-full max-w-full object-contain' : 'w-full'} rounded-lg border border-slate-200 dark:border-slate-800 cursor-crosshair select-none touch-none`} />
        </div>
      )}
      {!src && !err && <div className="h-40 rounded-lg bg-slate-100 dark:bg-slate-900 animate-pulse" />}
      <form onSubmit={submit} className="flex gap-1.5">
        <input value={text} onChange={e => setText(e.target.value)} placeholder="Type here (captcha, code…) — tap the box in the picture first"
          className="flex-1 min-w-0 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2.5 py-2 text-sm" autoCapitalize="off" autoCorrect="off" />
        <button type="submit" className="rounded-lg bg-indigo-600 text-white text-xs font-semibold px-3">Type ⏎</button>
      </form>
      <div className="flex flex-wrap gap-1.5">
        {[['⌫', { kind: 'key', key: 'Backspace' }], ['Tab', { kind: 'key', key: 'Tab' }], ['Esc', { kind: 'key', key: 'Escape' }],
          ['▲', { kind: 'scroll', dy: -500 }], ['▼', { kind: 'scroll', dy: 500 }], ['⇞ Top', { kind: 'key', key: 'Home' }], ['⇟ End', { kind: 'key', key: 'End' }]].map(([l, b]) => (
          <button key={l} type="button" onClick={() => send(b)} className={btn}>{l}</button>
        ))}
      </div>
    </div>
  )
}
