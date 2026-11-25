import { useEffect, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import api from '../services/api'
import LiveCanvas from './LiveCanvas'
import { clickIs, isClick, stateOf } from '../lib/liveClicks'

/**
 * A robot browser opened from the sidebar's Browsers (2026-11-22): the real
 * page fills the window and works like a browser — click, type, wheel, drag,
 * Ctrl+V. The tab's frames come from the PC the robot works on (screencast, as
 * they change); mouse, keys, wheel and paste go back in bursts, in order. Only
 * a slim back / forward / reload / address bar. Works the same for a robot on
 * another office PC: the main PC drives that browser and relays both ways.
 */
const NAMED = ['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Delete', 'PageDown', 'PageUp', 'Home', 'End', 'Insert']

async function giveCode(code) {
  try { await navigator.clipboard.writeText(code) } catch {}
  toast.success('Musaned code copied — paste it with Ctrl+V', { id: 'sign-in-code', duration: 4000 })
}

export default function BrowserView({ runId, title = '', onClose }) {
  // The shared stream (lib/liveView.js); a PC that has none (older): the picture stream of before.
  const [old, setOld] = useState(false)
  const [src, setSrc] = useState(null)
  const [meta, setMeta] = useState({ url: '' })
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [gone, setGone] = useState(null)
  // Until the first picture: "opening…"; no picture and no answer for a while: say so (never a grey page).
  const [seen, setSeen] = useState(false)
  const [slow, setSlow] = useState(null)
  const [tries, setTries] = useState(0)
  const box = useRef(null)
  const img = useRef(null)
  const queue = useRef([])
  const pumping = useRef(false)

  // The pictures: one stream, started again when it drops.
  useEffect(() => {
    if (!old) return
    let alive = true
    const start = () => alive && setSrc(`${api.defaults.baseURL}/automations/${runId}/stream?t=${Date.now()}`)
    start()
    setSeen(false); setSlow(null)
    const t = setTimeout(() => { if (alive) setSlow(s => s || 'The robot browser does not answer just now.') }, 12000)
    return () => { alive = false; clearTimeout(t) }
  }, [runId, tries, old])
  const dropped = () => { if (!gone) setTimeout(() => setSrc(`${api.defaults.baseURL}/automations/${runId}/stream?t=${Date.now()}`), 1000) }

  // The address, and whether the tab is still there. (The shared stream says both by itself.)
  useEffect(() => {
    if (!old) return
    let alive = true, timer
    const step = async () => {
      try {
        const r = await api.get(`/automations/${runId}/tab`, { timeout: 8000 })
        if (!alive) return
        setMeta(r.data); setGone(null); setSlow(null)
      } catch (e) {
        if (!alive) {}
        else if (e.response?.status === 404) setGone('No robot browser is running for this now. When a robot opens it again it shows here.')
        else setSlow(e.response?.data?.error || 'The robot browser does not answer just now.')
      }
      if (alive) timer = setTimeout(step, document.hidden ? 5000 : 1500)
    }
    step()
    return () => { alive = false; clearTimeout(timer) }
  }, [runId, old])
  useEffect(() => { if (!editing) setAddress(meta.url || '') }, [meta.url, editing])

  // Input: everything waiting goes in one request; moves and wheel turns merge.
  const pump = async () => {
    if (pumping.current) return
    pumping.current = true
    try {
      while (queue.current.length) {
        const batch = queue.current.splice(0, 100)
        try {
          const r = await api.post(`/automations/${runId}/input`, { batch }, { timeout: 20000 })
          if (r.data?.code) giveCode(r.data.code)
          if (batch.some(isClick)) clickIs(runId, stateOf(r.data))
        } catch (e) { if (batch.some(isClick)) clickIs(runId, 'failed'); if (e.response?.status === 404) setGone('This browser is closed.') }
      }
    } finally { pumping.current = false }
  }
  const put = (b) => {
    const q = queue.current, l = q[q.length - 1]
    if (l && b.kind === 'mouse' && b.type === 'move' && l.kind === 'mouse' && l.type === 'move') q[q.length - 1] = b
    else if (l && b.kind === 'wheel' && l.kind === 'wheel' && Math.abs(l.x - b.x) < 0.02 && Math.abs(l.y - b.y) < 0.02) { l.dx += b.dx; l.dy += b.dy }
    else q.push(b)
    pump()
  }
  const mods = (e) => ({ ctrl: e.ctrlKey || undefined, shift: e.shiftKey || undefined, alt: e.altKey || undefined, meta: e.metaKey || undefined })
  // Where on the page (0–1): the picture sits centred in the window, so its own edges count.
  const at = (e) => {
    const el = img.current; if (!el) return null
    const r = el.getBoundingClientRect(), nw = el.naturalWidth || (el.tagName === 'CANVAS' && el.width) || r.width, nh = el.naturalHeight || (el.tagName === 'CANVAS' && el.height) || r.height
    const k = Math.min(r.width / nw, r.height / nh), w = nw * k, h = nh * k
    const x = (e.clientX - r.left - (r.width - w) / 2) / w, y = (e.clientY - r.top - (r.height - h) / 2) / h
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 }
  }
  const mouse = (type) => (e) => {
    const p = at(e); if (!p || (type !== 'up' && !p.inside)) return
    if (type === 'down') { e.preventDefault(); box.current?.focus(); try { e.currentTarget.setPointerCapture?.(e.pointerId) } catch {} }
    put({ kind: 'mouse', type, x: p.x, y: p.y, button: e.button, buttons: e.buttons, clickCount: e.detail || 1, ...mods(e) })
  }
  const keyboard = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return   // the paste event brings the text
    if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return
    e.preventDefault()
    if (e.key.length !== 1 && !NAMED.includes(e.key) && !/^F\d{1,2}$/.test(e.key)) return
    put({ kind: 'key', key: e.key === ' ' ? 'Space' : e.key, ...mods(e) })
  }
  const paste = (e) => { const t = e.clipboardData?.getData('text'); if (t) { e.preventDefault(); put({ kind: 'paste', text: t }) } }
  // Wheel needs a non-passive listener so the window itself never scrolls.
  useEffect(() => {
    const el = box.current; if (!el) return
    const wheel = (e) => {
      e.preventDefault()
      const p = at(e); if (!p) return
      const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 600 : 1
      put({ kind: 'wheel', x: p.x, y: p.y, dx: Math.round(e.deltaX * k), dy: Math.round(e.deltaY * k), ...mods(e) })
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  })
  useEffect(() => { box.current?.focus() }, [])
  const go = (e) => {
    e.preventDefault(); setEditing(false)
    if (address.trim()) put({ kind: 'nav', url: address.trim() })
    box.current?.focus()
  }
  const btn = 'shrink-0 grid h-8 w-8 place-items-center rounded-lg border border-slate-300 dark:border-slate-600 text-sm font-semibold hover:bg-slate-100 dark:hover:bg-slate-800'

  return (
    <div className="fixed inset-0 z-[90] flex flex-col bg-white dark:bg-slate-950">
      <div className="flex items-center gap-1.5 border-b border-slate-200 dark:border-slate-800 p-1.5">
        <button type="button" className={btn} onClick={() => put({ kind: 'back' })} title="Back">←</button>
        <button type="button" className={btn} onClick={() => put({ kind: 'forward' })} title="Forward">→</button>
        <button type="button" className={btn} onClick={() => put({ kind: 'reload' })} title="Reload">↻</button>
        <form onSubmit={go} className="min-w-0 flex-1">
          <input value={address} onFocus={(e) => { setEditing(true); e.target.select() }} onBlur={() => setEditing(false)} onChange={(e) => setAddress(e.target.value)}
            title={title} aria-label="Address" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            className="h-8 w-full rounded-lg border border-slate-300 dark:border-slate-600 bg-slate-50 dark:bg-slate-900 px-2.5 font-mono text-xs" />
        </form>
        <button type="button" className={btn} onClick={onClose} title="Close">✕</button>
      </div>
      <div ref={box} tabIndex={0} onKeyDown={keyboard} onPaste={paste} onPointerDown={() => box.current?.focus()}
        className="relative min-h-0 flex-1 overflow-hidden bg-slate-100 outline-none dark:bg-slate-900" style={{ touchAction: 'none' }}>
        {!old && (
          <LiveCanvas runId={runId} canvasRef={img} onMeta={setMeta} onState={(st, t) => setGone(g => (st === 'gone' ? t || 'No robot browser is running for this now.' : null))} onUnsupported={() => setOld(true)}
            onPointerDown={mouse('down')} onPointerMove={mouse('move')} onPointerUp={mouse('up')} onContextMenu={(e) => e.preventDefault()}
            className="absolute inset-0 h-full w-full cursor-default select-none object-contain" />
        )}
        {old && src && !gone && (
          <img ref={img} src={src} alt="" draggable={false} onError={dropped} onLoad={() => { setSeen(true); setSlow(null) }}
            onPointerDown={mouse('down')} onPointerMove={mouse('move')} onPointerUp={mouse('up')} onContextMenu={(e) => e.preventDefault()}
            className="absolute inset-0 h-full w-full cursor-default select-none object-contain" />
        )}
        {old && gone && <p data-testid="browser-gone" className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-500">{gone}</p>}
        {old && !gone && !seen && (
          <div data-testid="browser-waiting" className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-500">
            {slow ? (
              <div className="pointer-events-auto space-y-3">
                <p>{slow}</p>
                <div className="flex justify-center gap-2">
                  <button type="button" onClick={() => setTries(n => n + 1)} className="rounded-lg bg-slate-900 px-3 py-1.5 font-semibold text-white dark:bg-white dark:text-slate-900">↻ Try again</button>
                  <button type="button" onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1.5 font-semibold dark:border-slate-600">Close</button>
                </div>
              </div>
            ) : <p>Opening the robot's browser…</p>}
          </div>
        )}
      </div>
    </div>
  )
}
