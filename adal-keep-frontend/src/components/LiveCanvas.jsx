import { useEffect, useRef, useState } from 'react'
import { watchLive } from '../lib/liveView'

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
  return (
    <>
      <canvas ref={ref} data-testid="live-canvas" width="1366" height="900" role="img" aria-label="The robot's browser"
        className={`${className} ${note.seen ? '' : 'invisible'}`} style={style} {...events} />
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
