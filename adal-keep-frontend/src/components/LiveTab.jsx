import { useEffect, useRef, useState } from 'react'
import api from '../services/api'
import { onBack, IN_PHONE_APP } from '../lib/phoneApp'

/**
 * The run's tab on the PC, live, and driven from here.
 *  📄 Page    — the tab read as a light, phone-sized page (backend
 *               services/pageMirror.js): its text, fields, lists, ticks and
 *               buttons; fill and tap them here, the PC does it on the real
 *               page. Captcha pictures / the reCAPTCHA box come as cut-outs.
 *  🖼 Picture — the tab's screen: tap to click, swipe to scroll, pinch or
 *               ＋/－ to magnify.
 * Live (Supabase Realtime) in the phone app and wherever the link is up;
 * elsewhere it is asked about once a second.
 */
const VIEW_KEY = 'adal-live-view'
const PHONE = IN_PHONE_APP || (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches)

export default function LiveTab({ runId, fill = false }) {
  const [view, setView] = useState(() => { try { return localStorage.getItem(VIEW_KEY) || (PHONE ? 'mirror' : 'picture') } catch { return 'picture' } })
  const [src, setSrc] = useState(null)
  const [page, setPage] = useState(null)        // the light page
  const [meta, setMeta] = useState({ url: '', title: '' })
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [err, setErr] = useState(null)
  const [text, setText] = useState('')
  const [full, setFull] = useState(false)
  const [mode, setMode] = useState('…')
  const [fps, setFps] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [busy, setBusy] = useState(false)
  const last = useRef(null)
  const live = useRef(null)          // the live link (cloud/live.js) when it is up
  const frames = useRef([])
  const drag = useRef(null)
  const pinch = useRef(null)
  const poke = useRef(null)          // ask for the next picture / page at once

  const pickView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v) } catch {} }
  const tick = () => {
    const now = Date.now()
    frames.current = [...frames.current.filter(t => now - t < 3000), now]
    setFps(Math.round(frames.current.length / 3))
  }
  const show = (url) => {
    if (last.current) URL.revokeObjectURL(last.current)
    last.current = url
    setSrc(url); setErr(null); tick()
  }
  const GONE = 'This run\'s tab on the PC was closed. Press ▶ Continue — the run opens it again and it shows here.'

  // Back closes full screen first (phone app).
  useEffect(() => full ? onBack(() => setFull(false)) : undefined, [full])

  useEffect(() => {
    let alive = true, timer = null, off = null, renew = null
    const start = async () => {
      if (window.__ADAL_CLOUD) {
        const L = await import('../cloud/live.js')
        if (L.liveReady()) {
          live.current = L
          setMode('live')
          const { gunzipJSON } = await import('../cloud/adapter.js')
          off = L.onLive(async (m) => {
            if (Number(m.run) !== Number(runId) || !alive) return
            if (m.t === 'inputError') { setErr(m.error); return }
            if (m.gone && (m.t === 'frame' || m.t === 'mirror')) { setErr(GONE); return }
            if (m.t === 'frame' && view === 'picture') {
              const bin = atob(m.img), bytes = new Uint8Array(bin.length)
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
              show(URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })))
              setMeta({ url: m.url || '', title: m.title || '' })
            } else if (m.t === 'mirror' && view === 'mirror' && m.gz) {
              const p = await gunzipJSON(m.gz)
              if (!alive) return
              setPage(p); setErr(null); tick(); setMeta({ url: p.url || '', title: p.title || '' })
            }
          })
          const watch = () => document.hidden || L.sendLive({ t: 'watch', run: runId, view })
          watch()
          renew = setInterval(watch, 8000)
          document.addEventListener('visibilitychange', watch)
          const offVis = () => document.removeEventListener('visibilitychange', watch)
          const prev = off; off = () => { prev(); offVis() }
          return
        }
      }
      // Otherwise: asked about once a second (slower while the app is hidden).
      setMode('pictures')
      const step = async () => {
        try {
          if (view === 'mirror') {
            const r = await api.get(`/automations/${runId}/mirror`)
            if (!alive) return
            setPage(r.data); setErr(null); tick(); setMeta({ url: r.data.url || '', title: r.data.title || '' })
          } else {
            const r = await api.get(`/automations/${runId}/screen`, { responseType: 'blob' })
            if (!alive) return
            show(URL.createObjectURL(r.data))
            const u = r.headers?.['x-tab-url']
            if (u) setMeta(m => ({ ...m, url: decodeURI(u) }))
          }
        } catch (e) {
          if (alive) setErr(e.response?.status === 404 ? GONE : 'The PC tab did not answer.')
        }
        if (alive) timer = setTimeout(step, document.hidden ? 5000 : 900)
      }
      poke.current = () => { clearTimeout(timer); timer = setTimeout(step, 250) }
      step()
    }
    start()
    return () => { alive = false; clearTimeout(timer); clearInterval(renew); off?.(); poke.current = null }
  }, [runId, view])

  useEffect(() => () => { if (last.current) URL.revokeObjectURL(last.current) }, [])
  useEffect(() => { if (!editing) setAddress(meta.url) }, [meta.url, editing])

  const send = async (body) => {
    if (live.current) return live.current.sendLive({ t: 'input', run: runId, ack: true, ...body })
    setBusy(true)
    try { await api.post(`/automations/${runId}/input`, body); setErr(null) }
    catch (e) { setErr(e.response?.data?.error || 'The PC did not do it.') }
    finally { setBusy(false); poke.current?.() }
  }

  // Picture: tap = click there; drag = scroll the page (or the picture when magnified); two fingers = magnify.
  const point = (e) => { const t = e.touches?.[0] || e.changedTouches?.[0] || e; return { x: t.clientX, y: t.clientY } }
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  const down = (e) => {
    if (e.touches?.length === 2) { pinch.current = { d: dist(e.touches), z: zoom }; drag.current = null; return }
    drag.current = { ...point(e), moved: false }
  }
  const move = (e) => {
    if (pinch.current && e.touches?.length === 2) {
      setZoom(Math.max(1, Math.min(4, +(pinch.current.z * dist(e.touches) / pinch.current.d).toFixed(2))))
      return
    }
    if (!drag.current) return
    const p = point(e), dy = drag.current.y - p.y, dx = drag.current.x - p.x
    if (Math.abs(dy) > 12 || Math.abs(dx) > 12) drag.current.moved = true
    if (zoom > 1) return                    // the box scrolls the magnified picture itself
    if (Math.abs(dy) > 25 || Math.abs(dx) > 25) {
      const r = e.currentTarget.getBoundingClientRect()
      const k = 1000 / r.width
      send({ kind: 'scroll', dy: Math.round(dy * k * 1.3), dx: Math.round(dx * k * 1.3) })
      drag.current = { ...p, moved: true }
    }
  }
  const up = (e) => {
    if (pinch.current) { if (!e.touches?.length) pinch.current = null; return }
    const d = drag.current; drag.current = null
    if (!d || d.moved) return
    const r = e.currentTarget.getBoundingClientRect(), p = point(e)
    send({ kind: 'click', x: (p.x - r.left) / r.width, y: (p.y - r.top) / r.height })
  }
  const wheel = (e) => { if (zoom === 1) send({ kind: 'scroll', dy: Math.round(e.deltaY), dx: Math.round(e.deltaX) }) }

  const submit = async (e) => {
    e.preventDefault()
    if (text) await send({ kind: 'type', text })
    await send({ kind: 'key', key: 'Enter' })
    setText('')
  }
  const go = (e) => { e.preventDefault(); setEditing(false); if (address.trim()) send({ kind: 'nav', url: address.trim() }) }

  const btn = 'shrink-0 rounded-lg border border-slate-300 dark:border-slate-600 px-2 py-1.5 text-xs font-semibold active:bg-slate-100 dark:active:bg-slate-800'
  const tabBtn = (v, label) => (
    <button type="button" onClick={() => pickView(v)}
      className={`flex-1 rounded-md py-1 text-xs font-semibold ${view === v ? 'bg-white dark:bg-slate-700 shadow text-indigo-700 dark:text-indigo-300' : 'text-slate-500'}`}>{label}</button>
  )
  return (
    <div className={fill
      ? 'h-full flex flex-col gap-1.5'
      : full
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
        {!fill && <button type="button" className={btn} onClick={() => setFull(f => !f)} title={full ? 'Smaller' : 'Full screen'}>{full ? '✕' : '⛶'}</button>}
      </div>
      <div className="flex items-center gap-2">
        <div className="flex flex-1 rounded-lg bg-slate-100 dark:bg-slate-900 p-0.5">
          {tabBtn('mirror', '📄 Page')}
          {tabBtn('picture', '🖼 Picture')}
        </div>
        <span className="shrink-0 text-[10px] text-slate-500">{busy ? '⏳' : mode === 'live' ? `⚡ ${fps}/s` : mode === 'pictures' ? '🔄' : '…'}</span>
      </div>
      {meta.title && !fill && <p className="text-[10px] text-slate-500 truncate">{meta.title}</p>}
      {err && <p className="text-xs rounded-lg bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 px-2 py-1.5">{err}</p>}

      {view === 'mirror' && (
        page
          ? <Mirror page={page} send={send} className={fill || full ? 'flex-1 min-h-0 overflow-y-auto overscroll-contain' : 'max-h-[70vh] overflow-y-auto'} />
          : !err && <div className="h-40 rounded-lg bg-slate-100 dark:bg-slate-900 animate-pulse" />
      )}

      {view === 'picture' && <>
        {src && (
          <div className={`${full || fill ? 'flex-1 min-h-0' : 'max-h-[70vh]'} overflow-auto rounded-lg border border-slate-200 dark:border-slate-800`}
            style={{ touchAction: zoom > 1 ? 'pan-x pan-y' : 'none' }}>
            <img src={src} alt="The run's tab on the PC" draggable={false}
              onMouseDown={down} onMouseMove={(e) => e.buttons && move(e)} onMouseUp={up}
              onTouchStart={down} onTouchMove={move} onTouchEnd={up} onWheel={wheel}
              style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}
              className="block cursor-crosshair select-none" />
          </div>
        )}
        {!src && !err && <div className="h-40 rounded-lg bg-slate-100 dark:bg-slate-900 animate-pulse" />}
        <div className="flex items-center gap-1.5">
          <button type="button" className={btn} onClick={() => setZoom(z => Math.max(1, +(z - 0.5).toFixed(1)))}>－</button>
          <span className="text-[11px] w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
          <button type="button" className={btn} onClick={() => setZoom(z => Math.min(4, +(z + 0.5).toFixed(1)))}>＋</button>
          <span className="text-[10px] text-slate-400 truncate">pinch to magnify · tap to click</span>
        </div>
        <form onSubmit={submit} className="flex gap-1.5">
          <input value={text} onChange={e => setText(e.target.value)} placeholder="Type here — tap the box in the picture first"
            className="flex-1 min-w-0 rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2.5 py-2 text-sm" autoCapitalize="off" autoCorrect="off" />
          <button type="submit" className="rounded-lg bg-indigo-600 text-white text-xs font-semibold px-3">Type ⏎</button>
        </form>
        <div className="flex flex-wrap gap-1.5">
          {[['⌫', { kind: 'key', key: 'Backspace' }], ['Tab', { kind: 'key', key: 'Tab' }], ['Esc', { kind: 'key', key: 'Escape' }],
            ['▲', { kind: 'scroll', dy: -500 }], ['▼', { kind: 'scroll', dy: 500 }], ['⇞ Top', { kind: 'key', key: 'Home' }], ['⇟ End', { kind: 'key', key: 'End' }]].map(([l, b]) => (
            <button key={l} type="button" onClick={() => send(b)} className={btn}>{l}</button>
          ))}
        </div>
      </>}
    </div>
  )
}

// ------------------------------------------------------------ the light page
function Mirror({ page, send, className }) {
  const blocks = page.blocks || []
  const box = useRef(null)
  const firstUrl = useRef(null)
  // What the page needs from a person: its error words, captchas, required
  // fields still empty, the field it is waiting in.
  const needs = []
  blocks.forEach((b, i) => {
    if (b.k === 't' && b.err) needs.push([i, '⚠️ ' + b.text.slice(0, 60)])
    else if (b.k === 'shot' && (b.frame || /captcha|robot|verif|code/i.test(b.label || ''))) needs.push([i, b.frame ? '🧩 ' + (b.label || 'Check box') : '🔤 ' + (b.label || 'Picture code')])
    else if ((b.k === 'input' || b.k === 'textarea' || b.k === 'select') && b.req && !b.value && !b.dis) needs.push([i, '✏️ ' + (b.label || 'Empty field')])
    else if (b.id && b.id === page.focus && b.k !== 'button' && b.k !== 'link') needs.push([i, '👉 ' + (b.label || 'Here')])
  })
  const jump = (i) => {
    const el = box.current?.querySelector(`[data-i="${i}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    el?.classList.add('ring-2', 'ring-amber-400'); setTimeout(() => el?.classList.remove('ring-2', 'ring-amber-400'), 1500)
    const b = blocks[i]; if (b?.k === 'shot' && b.off) send({ kind: 'reveal', id: b.id })
  }
  // A new page: start at what it needs (or the top).
  useEffect(() => {
    if (firstUrl.current === page.url) return
    firstUrl.current = page.url
    if (needs.length) setTimeout(() => jump(needs[0][0]), 100)
    else box.current?.scrollTo({ top: 0 })
  }, [page.url])  // eslint-disable-line react-hooks/exhaustive-deps

  if (!blocks.length) return <p className="text-xs text-slate-500 p-4 text-center">The page is empty or still loading.</p>
  // Buttons side by side wrap into one row, like the website's own bar.
  const rows = []
  blocks.forEach((b, i) => {
    const small = (b.k === 'button' && !b.opt && b.text.length <= 24) || b.k === 'link' && b.text.length <= 24
    const last = rows[rows.length - 1]
    if (small && last?.row) last.items.push([b, i])
    else rows.push(small ? { row: true, items: [[b, i]] } : { items: [[b, i]] })
  })
  return (
    <div ref={box} className={className}>
      {needs.length > 0 && (
        <div className="sticky top-0 z-10 -mx-0.5 mb-1.5 flex gap-1.5 overflow-x-auto bg-amber-50/95 dark:bg-amber-950/90 backdrop-blur px-1.5 py-1.5 rounded-lg">
          <span className="shrink-0 self-center text-[10px] font-bold uppercase text-amber-800 dark:text-amber-300">Needs you</span>
          {needs.slice(0, 12).map(([i, t]) => (
            <button key={i} type="button" onClick={() => jump(i)}
              className="shrink-0 max-w-[60vw] truncate rounded-full border border-amber-300 bg-white dark:bg-slate-900 px-2.5 py-1 text-[11px] font-semibold text-amber-900 dark:text-amber-200">{t}</button>
          ))}
        </div>
      )}
      <div className="space-y-1.5 text-sm px-0.5 pb-16">
        {rows.map((r, n) => r.row
          ? <div key={n} className="flex flex-wrap gap-1.5">{r.items.map(([b, i]) => <div key={b.id || i} data-i={i} className="rounded-lg"><Block b={b} send={send} focus={false} /></div>)}</div>
          : r.items.map(([b, i]) => <div key={b.id ? `e${b.id}` : `t${i}`} data-i={i} className="rounded-lg"><Block b={b} send={send} focus={page.focus === b.id} /></div>))}
      </div>
    </div>
  )
}

const field = 'w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 px-2.5 py-2 text-[15px] disabled:opacity-50'
const Label = ({ children, req }) => children ? <span className="block text-[11px] font-semibold text-slate-600 dark:text-slate-400 mb-0.5">{children}{req && <span className="text-red-500"> *</span>}</span> : null

function Block({ b, send, focus }) {
  switch (b.k) {
    case 't':
      if (b.h) return <p className={`font-bold text-slate-900 dark:text-white ${b.h <= 2 ? 'text-base pt-2' : 'text-sm pt-1'}`}>{b.text}</p>
      return <p className={`text-[13px] leading-snug ${b.err ? 'text-red-600 font-semibold' : 'text-slate-700 dark:text-slate-300'}`}>{b.text}</p>
    case 'input': case 'textarea': return <TextField b={b} send={send} focus={focus} />
    case 'select':
      return (
        <label className="block">
          <Label>{b.label}</Label>
          <select className={field} disabled={b.dis} value={b.value} onChange={(e) => send({ kind: 'pick', id: b.id, value: e.target.value })}>
            {(b.options || []).map(([v, t, , d], i) => <option key={i} value={v} disabled={d}>{t || v || '—'}</option>)}
          </select>
        </label>
      )
    case 'checkbox': case 'radio':
      return (
        <button type="button" disabled={b.dis} onClick={() => send({ kind: 'tap', id: b.id })}
          className="w-full flex items-center gap-2.5 rounded-lg border border-slate-200 dark:border-slate-700 px-2.5 py-2 text-left text-[13px] disabled:opacity-50">
          <span className={`shrink-0 grid place-items-center w-5 h-5 border-2 ${b.k === 'radio' ? 'rounded-full' : 'rounded'} ${b.on ? 'bg-indigo-600 border-indigo-600 text-white' : 'border-slate-400'}`}>{b.on ? '✓' : ''}</span>
          <span className="min-w-0">{b.label || '—'}</span>
        </button>
      )
    case 'button':
      return (
        <button type="button" disabled={b.dis} onClick={() => send({ kind: 'tap', id: b.id })}
          className={`${b.opt ? 'w-full text-left' : 'max-w-full'} rounded-lg px-3 py-2 text-[13px] font-semibold disabled:opacity-40 ${b.sel ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-100 active:bg-indigo-100'}`}>
          {b.text}
        </button>
      )
    case 'link':
      return <button type="button" onClick={() => send({ kind: 'tap', id: b.id })} className={`block text-left text-[13px] underline ${b.sel ? 'font-bold text-indigo-700' : 'text-indigo-600 dark:text-indigo-400'}`}>{b.text}</button>
    case 'file':
      return <p className="text-[12px] rounded-lg border border-dashed border-slate-300 px-2.5 py-2 text-slate-500">📎 {b.label || 'File'} — the run puts the files in; use 🖼 Picture to look.</p>
    case 'shot': return <Shot b={b} send={send} />
    default: return null
  }
}

function TextField({ b, send, focus }) {
  const [v, setV] = useState(b.value)
  const [mine, setMine] = useState(false)       // being typed here: the PC's value waits
  useEffect(() => { if (!mine) setV(b.value) }, [b.value, mine])
  const put = (enter) => {
    setMine(false)
    if (b.type === 'password' && !v && !enter) { setV(b.value); return }   // looked, typed nothing: keep the PC's
    if (v !== b.value || enter) send({ kind: 'set', id: b.id, value: v, enter })
  }
  const type = { password: 'password', email: 'email', number: 'text', tel: 'tel', date: 'date', search: 'search' }[b.type] || 'text'
  const common = {
    value: v, disabled: b.dis, readOnly: b.ro, placeholder: b.ph || '',
    onFocus: () => setMine(true), onChange: (e) => setV(e.target.value), onBlur: () => put(false),
    autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false,
    className: `${field} ${focus ? 'ring-2 ring-indigo-400' : ''}`,
  }
  return (
    <label className="block">
      <Label req={b.req}>{b.label}</Label>
      {b.k === 'textarea'
        ? <textarea rows={3} {...common} />
        : <input type={b.type === 'password' && !mine ? 'text' : type} inputMode={b.type === 'number' ? 'decimal' : undefined}
            {...common} value={b.type === 'password' && !mine ? b.value : v}
            onFocus={() => { setMine(true); if (b.type === 'password') setV('') }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); put(true); e.currentTarget.blur() } }} />}
    </label>
  )
}

function Shot({ b, send }) {
  if (b.off || !b.img) return (
    <button type="button" onClick={() => send({ kind: 'reveal', id: b.id })}
      className="w-full rounded-lg border border-dashed border-slate-300 dark:border-slate-600 py-2 text-[12px] text-slate-500">
      {b.frame ? '🧩' : '🖼'} {b.label || (b.frame ? 'A box from another site (captcha …)' : 'A picture')} — tap to show
    </button>
  )
  const tap = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    send({ kind: 'tapAt', id: b.id, fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height })
  }
  return (
    <img src={`data:image/jpeg;base64,${b.img}`} alt={b.label || ''} onClick={b.click ? tap : undefined} draggable={false}
      style={{ aspectRatio: b.ar || undefined }}
      className={`block max-w-full rounded-md border border-slate-200 dark:border-slate-700 ${b.click ? 'cursor-pointer' : ''} ${b.frame ? 'w-full' : ''}`} />
  )
}
