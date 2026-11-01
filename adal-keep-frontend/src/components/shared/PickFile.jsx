import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { IN_PHONE_APP } from '../../lib/phoneApp'

// The Camera · Gallery · Files choice is for phones; a PC opens its file window at once.
export const ON_PHONE = IN_PHONE_APP || (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches && window.innerWidth < 900)

/**
 * Where a file comes from. On a phone the camera opens at once (sliding up)
 * with 🖼️ Gallery, 📁 Files, ⚡ Light and ⟲ Turn on it; a PC opens its file
 * window. Where a live camera is not allowed, the phone's camera app opens.
 *   const pick = usePickFile({ accept, multiple, onFiles })
 *   <button onClick={pick.open}>Upload</button> {pick.element}
 */
export function usePickFile({ accept = 'image/*,application/pdf', multiple = false, onFiles, guide = false }) {
  const [camera, setCamera] = useState(false)
  const cameraRef = useRef(null), galleryRef = useRef(null), filesRef = useRef(null)
  const take = (list) => { const files = Array.from(list || []); if (files.length) onFiles(files) }
  const liveCamera = () => !!(navigator.mediaDevices?.getUserMedia && window.isSecureContext)
  const choose = (what) => {
    if (what === 'camera') { if (liveCamera()) setCamera(true); else cameraRef.current?.click() }
    else { setCamera(false); (what === 'gallery' ? galleryRef : filesRef).current?.click() }
  }
  const input = (ref, props) => <input ref={ref} type="file" className="hidden" {...props}
    onChange={(e) => { const f = e.target.files; take(f); e.target.value = '' }} />
  const element = (
    <>
      {input(cameraRef, { accept: 'image/*', capture: 'environment' })}
      {input(galleryRef, { accept: 'image/*', multiple })}
      {input(filesRef, { accept, multiple })}
      {camera && <CameraShot guide={guide}
        onShot={(f) => { setCamera(false); take([f]) }}
        onClose={() => setCamera(false)}
        onGallery={() => choose('gallery')} onFiles={() => choose('files')}
        onFail={() => { setCamera(false); cameraRef.current?.click() }} />}
    </>
  )
  return { open: () => (ON_PHONE ? choose('camera') : filesRef.current?.click()), choose, element }
}

/**
 * The live camera (back camera on a phone, the webcam on a PC), sliding up:
 * a wide frame, the shutter, 🖼️ Gallery / 📁 Files beside it, ⚡ Light and
 * ⟲ Turn on top; after the shot a quick look with Retake / Use photo.
 */
export function CameraShot({ onShot, onClose, onFail, onGallery, onFiles, guide = true }) {
  const video = useRef(null)
  const stream = useRef(null)
  const [ready, setReady] = useState(false)
  const [shown, setShown] = useState(false)
  const [facing, setFacing] = useState('environment')
  const [torch, setTorch] = useState(null)     // null: this camera has no light
  const [shot, setShot] = useState(null)       // { url, file }
  const [flash, setFlash] = useState(false)
  useEffect(() => { const t = setTimeout(() => setShown(true), 16); return () => clearTimeout(t) }, [])
  useEffect(() => {
    let off = false
    setReady(false); setTorch(null)
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false })
      .then(s => {
        if (off) { s.getTracks().forEach(t => t.stop()); return }
        stream.current = s
        const track = s.getVideoTracks()[0]
        try { if (track?.getCapabilities?.().torch) setTorch(false) } catch {}
        video.current.srcObject = s
        video.current.play().then(() => setReady(true)).catch(() => setReady(true))
      })
      .catch(() => onFail?.())
    return () => { off = true; stream.current?.getTracks().forEach(t => t.stop()) }
  }, [facing])
  const light = async () => {
    const track = stream.current?.getVideoTracks()[0]
    if (!track || torch === null) return
    try { await track.applyConstraints({ advanced: [{ torch: !torch }] }); setTorch(!torch) } catch {}
  }
  const close = (then) => { setShown(false); setTimeout(() => (then || onClose)(), 220) }
  const shoot = () => {
    const v = video.current
    if (!v?.videoWidth) return
    setFlash(true); setTimeout(() => setFlash(false), 180)
    const c = document.createElement('canvas')
    c.width = v.videoWidth; c.height = v.videoHeight
    c.getContext('2d').drawImage(v, 0, 0)
    c.toBlob(b => {
      if (!b) return
      const file = new File([b], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })
      setShot({ url: URL.createObjectURL(b), file })
    }, 'image/jpeg', 0.92)
  }
  useEffect(() => () => { if (shot?.url) URL.revokeObjectURL(shot.url) }, [shot])
  const round = 'flex h-11 w-11 items-center justify-center rounded-full bg-white/15 text-white backdrop-blur active:scale-90 transition'
  const side = 'flex w-16 flex-col items-center gap-1 text-[11px] font-semibold text-white/85 active:scale-95 transition'
  // On the screen itself (document.body), never inside a page.
  return createPortal(
    <div className={`fixed inset-0 z-[95] flex flex-col bg-black transition-opacity duration-200 ${shown ? 'opacity-100' : 'opacity-0'}`}>
      <div className={`flex h-full flex-col transition-transform duration-300 ease-out ${shown ? 'translate-y-0' : 'translate-y-8'}`}>
        {/* Top: close, light, turn */}
        <div className="flex items-center justify-between px-4 pt-[calc(.75rem+env(safe-area-inset-top))] pb-2">
          <button type="button" onClick={() => close()} className={round} aria-label="Close">✕</button>
          <div className="flex gap-2">
            {torch !== null && !shot && (
              <button type="button" onClick={light} aria-label="Light" className={`${round} ${torch ? '!bg-amber-400 !text-black' : ''}`}>⚡</button>
            )}
            {!shot && <button type="button" onClick={() => setFacing(f => f === 'environment' ? 'user' : 'environment')} className={round} aria-label="Turn the camera">⟲</button>}
          </div>
        </div>

        {/* The wide frame */}
        <div className="flex flex-1 min-h-0 items-center justify-center px-3">
          <div className="relative w-full max-w-3xl overflow-hidden rounded-3xl bg-neutral-900 shadow-2xl ring-1 ring-white/10" style={{ aspectRatio: '4 / 3', maxHeight: '100%' }}>
            <video ref={video} playsInline muted className={`h-full w-full object-cover ${shot ? 'invisible' : ''}`} />
            {shot && <img src={shot.url} alt="" className="absolute inset-0 h-full w-full object-cover" />}
            {guide && !shot && <div className="pointer-events-none absolute inset-[7%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,.28)]" />}
            {!ready && !shot && <div className="absolute inset-0 flex items-center justify-center"><span className="h-8 w-8 animate-spin rounded-full border-2 border-white/30 border-t-white" /></div>}
            <div className={`pointer-events-none absolute inset-0 bg-white transition-opacity duration-150 ${flash ? 'opacity-90' : 'opacity-0'}`} />
          </div>
        </div>

        {/* Bottom: gallery · shutter · files — or retake / use */}
        <div className="px-6 pt-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
          {shot ? (
            <div className="flex items-center justify-center gap-3">
              <button type="button" onClick={() => setShot(null)} className="rounded-full bg-white/15 px-6 py-3 text-sm font-semibold text-white active:scale-95">↺ Retake</button>
              <button type="button" onClick={() => { const f = shot.file; close(() => onShot(f)) }} className="rounded-full bg-teal-500 px-7 py-3 text-sm font-bold text-white shadow-lg shadow-teal-500/30 active:scale-95">✓ Use photo</button>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <button type="button" onClick={() => onGallery ? close(onGallery) : null} className={side} disabled={!onGallery}>
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 text-2xl">🖼️</span>Gallery
              </button>
              <button type="button" onClick={shoot} disabled={!ready} aria-label="Take the picture"
                className="h-[74px] w-[74px] rounded-full border-4 border-white/90 p-1 transition active:scale-90 disabled:opacity-40">
                <span className="block h-full w-full rounded-full bg-white" />
              </button>
              <button type="button" onClick={() => onFiles ? close(onFiles) : null} className={side} disabled={!onFiles}>
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/15 text-2xl">📁</span>Files
              </button>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}
