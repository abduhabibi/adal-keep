/**
 * Pictures cropped with double "C" anywhere on this PC (backend
 * services/screenClip.js, its watcher bin/adal-clip.exe) come into this
 * page's tray — also when the crop was made in another program (asked on
 * 2026-11-16). window.__adalClipHook: the watcher runs, so the page's own
 * double-C (FileTray) leaves it to the watcher.
 */
import toast from 'react-hot-toast'

let started = false
export function startClipWatch() {
  if (started || typeof EventSource === 'undefined') return
  started = true
  let wait = null
  const es = new EventSource('/api/app/clips')
  es.onmessage = async (e) => {
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
  es.onerror = () => { window.__adalClipHook = false }
}
