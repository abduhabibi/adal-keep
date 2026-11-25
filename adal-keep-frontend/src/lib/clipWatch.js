/**
 * Pictures cropped with double "C" anywhere on this PC (backend
 * services/screenClip.js, its watcher bin/adal-clip.exe) come into this
 * page's tray — also when the crop was made in another program (asked on
 * 2026-11-16). window.__adalClipHook: the watcher runs, so the page's own
 * double-C (FileTray) leaves it to the watcher.
 */
import toast from 'react-hot-toast'

let started = false
export async function startClipWatch() {
  if (started || typeof EventSource === 'undefined') return
  started = true
  let wait = null
  // The window's one stream (lib/appStream.js) carries the pictures as "clips" events.
  const { appStream, changesStream, farWindow } = await import('./appStream.js')
  // On another PC: the line /api/changes it has anyway (its own watcher's pictures come through the main PC).
  const shared = appStream() || (farWindow() ? changesStream() : null)
  if (!shared && !/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) return   // (an online copy: no PC's crops here)
  const es = shared || new EventSource('/api/app/clips')
  const got = async (e) => {
    let m = {}
    try { m = JSON.parse(e.data) } catch { return }
    if ('hook' in m) window.__adalClipHook = !!m.hook
    if (m.state === 'cropping') { toast.dismiss(wait || undefined); wait = toast.loading('Crop what you need… (Esc: no crop)', { duration: 120000 }) }
    if (m.state === 'none') { toast.dismiss(wait || undefined); wait = null }
    if (m.clip) {
      toast.dismiss(wait || undefined); wait = null
      try {
        const r = await fetch(`/api/app/clips/${m.clip}`)
        if (!r.ok) return
        const blob = await r.blob()
        const file = new File([blob], `Screenshot ${new Date().toLocaleString().replace(/[/:]/g, '-')}.png`, { type: 'image/png' })
        window.dispatchEvent(new CustomEvent('adal-tray-files', { detail: [file] }))
      } catch {}
    }
  }
  if (shared) es.addEventListener('clips', got)
  else es.onmessage = got
  es.addEventListener('error', () => { window.__adalClipHook = false })
}
