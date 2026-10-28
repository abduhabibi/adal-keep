import { useEffect, useRef, useState } from 'react'
import { IN_PHONE_APP } from '../../lib/phoneApp'

// The Camera · Gallery · Files choice is for phones; a PC opens its file window at once.
export const ON_PHONE = IN_PHONE_APP || (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches && window.innerWidth < 900)

/**
 * Where a file comes from — the three choices everywhere a file is added:
 * 📷 Camera (the live camera here; the phone's camera app where a browser
 * does not allow it), 🖼️ Gallery (pictures), 📁 Files (pictures, PDFs …).
 *   const pick = usePickFile({ accept, multiple, onFiles })
 *   <button onClick={pick.open}>Upload</button> {pick.element}
 */
export function usePickFile({ accept = 'image/*,application/pdf', multiple = false, onFiles, guide = false }) {
  const [menu, setMenu] = useState(false)
  const [camera, setCamera] = useState(false)
  const cameraRef = useRef(null), galleryRef = useRef(null), filesRef = useRef(null)
  const take = (list) => { const files = Array.from(list || []); if (files.length) onFiles(files) }
  const choose = (what) => {
    setMenu(false)
    if (what === 'camera') {
      if (navigator.mediaDevices?.getUserMedia && window.isSecureContext) setCamera(true)
      else cameraRef.current?.click()
    } else (what === 'gallery' ? galleryRef : filesRef).current?.click()
  }
  const input = (ref, props) => <input ref={ref} type="file" className="hidden" {...props}
    onChange={(e) => { const f = e.target.files; take(f); e.target.value = '' }} />
  const element = (
    <>
      {input(cameraRef, { accept: 'image/*', capture: 'environment' })}
      {input(galleryRef, { accept: 'image/*', multiple })}
      {input(filesRef, { accept, multiple })}
      {menu && (
        <div className="fixed inset-0 z-[94] bg-black/40 flex items-end sm:items-center justify-center p-3" onClick={() => setMenu(false)}>
          <div className="w-full max-w-sm rounded-2xl bg-white dark:bg-slate-900 p-3 shadow-2xl pb-[calc(.75rem+env(safe-area-inset-bottom))]" onClick={(e) => e.stopPropagation()}>
            <div className="grid grid-cols-3 gap-2">
              {[['camera', '📷', 'Camera'], ['gallery', '🖼️', 'Gallery'], ['files', '📁', 'Files']].map(([k, icon, label]) => (
                <button key={k} type="button" onClick={() => choose(k)}
                  className="flex flex-col items-center gap-1 rounded-xl border border-slate-200 dark:border-slate-700 py-4 text-sm font-semibold hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-900/20 active:scale-[.97]">
                  <span className="text-3xl">{icon}</span>{label}
                </button>
              ))}
            </div>
            <button type="button" onClick={() => setMenu(false)} className="mt-2 w-full rounded-xl py-2.5 text-sm text-slate-500">Cancel</button>
          </div>
        </div>
      )}
      {camera && <CameraShot guide={guide} onShot={(f) => { setCamera(false); take([f]) }} onClose={() => setCamera(false)} onFail={() => { setCamera(false); cameraRef.current?.click() }} />}
    </>
  )
  return { open: () => (ON_PHONE ? setMenu(true) : filesRef.current?.click()), choose, element }
}

/** The live camera (back camera on a phone, the webcam on a PC): take a picture. */
export function CameraShot({ onShot, onClose, onFail, guide = true }) {
  const video = useRef(null)
  const stream = useRef(null)
  const [ready, setReady] = useState(false)
  const [facing, setFacing] = useState('environment')
  useEffect(() => {
    let off = false
    navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false })
      .then(s => {
        if (off) { s.getTracks().forEach(t => t.stop()); return }
        stream.current = s
        video.current.srcObject = s
        video.current.play().then(() => setReady(true)).catch(() => setReady(true))
      })
      .catch(() => onFail())
    return () => { off = true; stream.current?.getTracks().forEach(t => t.stop()) }
  }, [facing])
  const shoot = () => {
    const v = video.current
    if (!v?.videoWidth) return
    const c = document.createElement('canvas')
    c.width = v.videoWidth; c.height = v.videoHeight
    c.getContext('2d').drawImage(v, 0, 0)
    c.toBlob(b => b && onShot(new File([b], `photo-${Date.now()}.jpg`, { type: 'image/jpeg' })), 'image/jpeg', 0.92)
  }
  return (
    <div className="fixed inset-0 z-[95] bg-black flex flex-col">
      <div className="relative flex-1 min-h-0 flex items-center justify-center">
        <video ref={video} playsInline muted className="max-h-full max-w-full" />
        {guide && <div className="pointer-events-none absolute inset-x-[6%] top-1/2 -translate-y-1/2 aspect-[1.42] max-h-[80%] rounded-2xl border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,.35)]" />}
        {!ready && <p className="absolute text-white/80 text-sm">Opening the camera…</p>}
      </div>
      <div className="flex items-center justify-between gap-3 p-4 pb-[calc(1rem+env(safe-area-inset-bottom))] bg-black">
        <button type="button" onClick={onClose} className="rounded-full bg-white/15 text-white px-4 py-2 text-sm font-semibold">Cancel</button>
        <button type="button" onClick={shoot} disabled={!ready} aria-label="Take the picture"
          className="h-16 w-16 rounded-full bg-white ring-4 ring-white/40 active:scale-95 disabled:opacity-50" />
        <button type="button" onClick={() => setFacing(f => f === 'environment' ? 'user' : 'environment')} className="rounded-full bg-white/15 text-white px-4 py-2 text-sm font-semibold">⟲ Turn</button>
      </div>
    </div>
  )
}
