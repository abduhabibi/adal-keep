import { useEffect, useRef, useState } from 'react'
import { watchLive } from '../lib/liveView'
import { onClicks } from '../lib/liveClicks'

const RING = { sent: 'border-sky-500 bg-sky-500/20', taken: 'border-emerald-500 bg-emerald-500/25', waiting: 'border-amber-500 bg-amber-500/20 animate-pulse', failed: 'border-red-500 bg-red-500/20' }
const WORD = { sent: 'sent', taken: 'taken', waiting: 'sent — the page is slow, it is kept', failed: 'not sent' }

/**
 * The robot's browser, live, on a canvas (lib/liveView.js: one stream a run; only what changed is drawn). It shows
 * the last picture at once and keeps it while the line comes back, with a word about it — never a broken picture.
 * onUnsupported: that PC has no such stream (older): the caller shows its older view.
 */
export default function LiveCanvas({ runId, canvasRef = null, onMeta, onState, onPicture, onUnsupported, className = '', style, ...events }) {
  const own = useRef(null)
  const ref = canvasRef || own
  const cb = useRef({})
  cb.current = { onMeta, onState, onPicture, onUnsupported }
  const [note, setNote] = useState({ state: 'connecting', text: 'Opening the robot\'s browser…', seen: false })
  useEffect(() => {
    const [, leave] = watchLive(runId, (what, h) => {
      if (what === 'state') {
        if (h.state === 'unsupported') return cb.current.onUnsupported?.()
        setNote({ state: h.state, text: h.text, seen: h.seen }); cb.current.onState?.(h.state, h.text)
      } else if (what === 'meta') cb.current.onMeta?.(h.meta)
      else {
        const c = ref.current
        if (!c) return
        if (c.width !== h.canvas.width || c.height !== h.canvas.height) { c.width = h.canvas.width; c.height = h.canvas.height }
        c.getContext('2d', { alpha: false }).drawImage(h.canvas, 0, 0)
        setNote(n => (n.seen && n.state === h.state ? n : { state: h.state, text: h.text, seen: true }))
        cb.current.onPicture?.(h)
      }
    })
    return leave
  }, [runId]) // eslint-disable-line react-hooks/exhaustive-deps
  // The ring where a click was pressed: at once, then what became of it.
  const [ring, setRing] = useState(null)
  const ringTimer = useRef(null)
  useEffect(() => onClicks(runId, (state) => {
    setRing(r => (r ? { ...r, state } : r))
    clearTimeout(ringTimer.current)
    ringTimer.current = setTimeout(() => setRing(null), state === 'taken' ? 700 : state === 'waiting' ? 8000 : 2500)
  }), [runId])
  useEffect(() => () => clearTimeout(ringTimer.current), [])
  const pressed = (name) => (e) => {
    const p = e.currentTarget.parentElement, b = p.getBoundingClientRect()
    setRing({ x: e.clientX - b.left + p.scrollLeft, y: e.clientY - b.top + p.scrollTop, state: 'sent', n: Date.now() })
    clearTimeout(ringTimer.current)
    ringTimer.current = setTimeout(() => setRing(null), 8000)
    events[name]?.(e)
  }
  const down = events.onPointerDown ? { onPointerDown: pressed('onPointerDown') } : events.onMouseDown ? { onMouseDown: pressed('onMouseDown') } : {}
  return (
    <>
      {ring && (
        <div data-testid="live-click" data-state={ring.state} className="pointer-events-none absolute z-20" style={{ left: ring.x, top: ring.y }}>
          <span key={ring.n} className={`absolute -left-4 -top-4 h-8 w-8 rounded-full border-2 ${RING[ring.state]}`} />
          <span className="absolute left-5 top-[-10px] whitespace-nowrap rounded-full bg-slate-900/80 px-2 py-0.5 text-[11px] font-semibold text-white">{WORD[ring.state]}</span>
        </div>
      )}
      <canvas ref={ref} data-testid="live-canvas" width="1366" height="900" role="img" aria-label="The robot's browser"
        className={`${className} ${note.seen ? '' : 'invisible'}`} style={style} {...events} {...down} />
      {note.state !== 'live' && (
        <div data-testid="live-note" className={`pointer-events-none absolute inset-x-0 z-10 flex justify-center p-3 ${note.seen ? 'top-0' : 'inset-y-0 items-center'}`}>
          <span className="flex items-center gap-2 rounded-full bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-white">
            {note.state !== 'gone' && <span className="h-3 w-3 animate-spin rounded-full border-2 border-white/40 border-t-white" />}
            {note.text || 'Opening the robot\'s browser…'}
          </span>
        </div>
      )}
    </>
  )
}
