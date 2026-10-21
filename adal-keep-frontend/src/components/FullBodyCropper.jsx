import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Crop a full body photo to the shape every CV template uses for it:
 * 1 wide × 3 tall (measured in all templates). Drag to move, slider or mouse
 * wheel to zoom; zooming out past the edges fills with white, so a head or
 * feet never have to be cut off. onDone(file) gets a 600 × 1800 JPEG.
 */
const RATIO = 1 / 3
const OUT_W = 600
const OUT_H = 1800

export default function FullBodyCropper({ file, onDone, onCancel }) {
  const [img, setImg] = useState(null)
  const [frame, setFrame] = useState({ w: 200, h: 600 })
  const [view, setView] = useState({ s: 1, x: 0, y: 0 })   // scale and image top-left inside the frame
  const [limits, setLimits] = useState({ min: 0.1, cover: 1, max: 4 })
  const drag = useRef(null)
  const url = useRef(null)

  // Load the picture; the frame fills most of the screen height.
  useEffect(() => {
    url.current = URL.createObjectURL(file)
    const im = new Image()
    im.onload = () => {
      const h = Math.min(window.innerHeight * 0.72, 720)
      const w = h * RATIO
      const cover = Math.max(w / im.naturalWidth, h / im.naturalHeight)
      const contain = Math.min(w / im.naturalWidth, h / im.naturalHeight)
      setFrame({ w, h })
      setLimits({ min: contain, cover, max: cover * 5 })
      setImg(im)
      setView(place(cover, null, im, { w, h }))
    }
    im.src = url.current
    return () => URL.revokeObjectURL(url.current)
  }, [file])

  // Keep the picture over the frame (or centred inside it when zoomed out).
  function clampAxis(pos, size, room) {
    return size >= room ? Math.min(0, Math.max(room - size, pos)) : (room - size) / 2
  }
  function place(s, anchor, im = img, fr = frame, prev = view) {
    const iw = im.naturalWidth * s, ih = im.naturalHeight * s
    let x, y
    if (!anchor) { x = (fr.w - iw) / 2; y = (fr.h - ih) / 2 }
    else {
      // zoom around the anchor point (frame coordinates)
      const k = s / prev.s
      x = anchor.x - (anchor.x - prev.x) * k
      y = anchor.y - (anchor.y - prev.y) * k
    }
    return { s, x: clampAxis(x, iw, fr.w), y: clampAxis(y, ih, fr.h) }
  }
  const zoomTo = (s, anchor = { x: frame.w / 2, y: frame.h / 2 }) =>
    setView(v => place(Math.min(limits.max, Math.max(limits.min, s)), anchor, img, frame, v))

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { px: e.clientX, py: e.clientY, x: view.x, y: view.y }
  }
  const onPointerMove = (e) => {
    if (!drag.current || !img) return
    const d = drag.current
    const iw = img.naturalWidth * view.s, ih = img.naturalHeight * view.s
    setView(v => ({ ...v, x: clampAxis(d.x + e.clientX - d.px, iw, frame.w), y: clampAxis(d.y + e.clientY - d.py, ih, frame.h) }))
  }
  const onWheel = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    zoomTo(view.s * (e.deltaY < 0 ? 1.08 : 1 / 1.08), { x: e.clientX - r.left, y: e.clientY - r.top })
  }

  const save = () => {
    const c = document.createElement('canvas')
    c.width = OUT_W; c.height = OUT_H
    const g = c.getContext('2d')
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, OUT_W, OUT_H)
    const k = OUT_W / frame.w
    g.imageSmoothingQuality = 'high'
    g.drawImage(img, view.x * k, view.y * k, img.naturalWidth * view.s * k, img.naturalHeight * view.s * k)
    c.toBlob(b => {
      const name = (file.name || 'full-body').replace(/\.[^.]+$/, '') + '-cropped.jpg'
      onDone(new File([b], name, { type: 'image/jpeg' }))
    }, 'image/jpeg', 0.9)
  }

  // Esc cancels, Enter saves.
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onCancel(); if (e.key === 'Enter' && img) save() }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  return createPortal(
    <div className="fixed inset-0 z-[100000] flex items-center justify-center bg-slate-950/80 p-4" onMouseDown={e => e.target === e.currentTarget && onCancel()}>
      <div className="flex max-h-full flex-col gap-4 rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-900 sm:flex-row">
        <div
          className="relative shrink-0 cursor-grab touch-none select-none overflow-hidden rounded-lg bg-white ring-2 ring-teal-500 active:cursor-grabbing"
          style={{ width: frame.w, height: frame.h }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={() => { drag.current = null }}
          onWheel={onWheel}
        >
          {img && (
            <img src={url.current} alt="" draggable={false} className="pointer-events-none absolute max-w-none"
              style={{ left: view.x, top: view.y, width: img.naturalWidth * view.s, height: img.naturalHeight * view.s }} />
          )}
          {/* where the head and the feet go */}
          <div className="pointer-events-none absolute inset-x-0 top-[4%] border-t-2 border-dashed border-teal-400/80" />
          <div className="pointer-events-none absolute inset-x-0 top-[96%] border-t-2 border-dashed border-teal-400/80" />
          <span className="pointer-events-none absolute left-1 top-[4%] mt-0.5 rounded bg-teal-600/80 px-1 text-[10px] text-white">head</span>
          <span className="pointer-events-none absolute left-1 top-[96%] -mt-4 rounded bg-teal-600/80 px-1 text-[10px] text-white">feet</span>
        </div>

        <div className="flex w-64 flex-col gap-4">
          <div>
            <h2 className="text-lg font-bold text-slate-900 dark:text-white">Crop the full body photo</h2>
            <p className="mt-1 text-sm text-slate-500">
              This is exactly the shape the CV shows. Drag the photo to move it and zoom so the
              <b> head is at the top line</b> and the <b>feet at the bottom line</b>.
            </p>
          </div>
          <label className="text-xs font-medium text-slate-500">
            Zoom
            <input type="range" className="mt-1 w-full accent-teal-600" min={limits.min} max={limits.max} step={(limits.max - limits.min) / 200 || 0.01}
              value={view.s} onChange={e => zoomTo(Number(e.target.value))} />
          </label>
          <div className="flex gap-2 text-xs">
            <button type="button" className="rounded-lg border border-slate-300 px-2 py-1.5 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
              onClick={() => setView(place(limits.cover, null))}>Fill the frame</button>
            <button type="button" className="rounded-lg border border-slate-300 px-2 py-1.5 hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
              onClick={() => setView(place(limits.min, null))}>Whole photo</button>
          </div>
          <div className="mt-auto flex flex-col gap-2">
            <button type="button" disabled={!img} onClick={save}
              className="rounded-lg bg-teal-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
              Use this crop
            </button>
            <button type="button" onClick={() => onDone(file)} className="text-xs text-slate-500 hover:underline">
              Keep the photo as it is
            </button>
            <button type="button" onClick={onCancel} className="text-xs text-red-600 hover:underline">Cancel</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
