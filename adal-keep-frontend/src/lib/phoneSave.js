/**
 * Downloads inside the phone app: its WebView ignores page downloads, so a
 * file a page makes (a CV PDF, an Excel list, a picture) is handed to the app
 * (AdalDiscovery.saveFile): it goes to Downloads/Adal Keep and opens. Every
 * <a download> click is caught here, also ones a page makes and clicks by
 * itself (blob:, data: and /api/… links alike), so no page needs to know.
 */
const plugin = () => window.Capacitor?.Plugins?.AdalDiscovery
export const canSaveOnPhone = () => !!plugin()?.saveFile

const toBase64 = (blob) => new Promise((ok, no) => {
  const r = new FileReader()
  r.onload = () => ok(String(r.result).split(',')[1] || '')
  r.onerror = no
  r.readAsDataURL(blob)
})

/** A file to this phone's Downloads (and open it, or share it). False when not in the app. */
export async function saveOnPhone(blob, name, { share = false } = {}) {
  if (!canSaveOnPhone()) return false
  await plugin().saveFile({ base64: await toBase64(blob), name: name || 'Adal Keep file', mime: blob.type || 'application/octet-stream', open: !share, share })
  return true
}

async function blobOf(href) {
  if (/^(blob:|data:)/.test(href)) return (await fetch(href)).blob()
  const u = new URL(href, location.origin)
  if (u.origin === location.origin && u.pathname.startsWith('/api/')) {
    const { default: api } = await import('../services/api')
    return (await api.get(u.pathname.replace(/^\/api/, ''), { params: Object.fromEntries(u.searchParams), responseType: 'blob' })).data
  }
  return null
}

export function catchDownloads() {
  if (!canSaveOnPhone() || window.__adalDownloads) return
  window.__adalDownloads = true
  document.addEventListener('click', (e) => {
    const a = e.target?.closest?.('a[download], a[href^="/api/cv/generated/"], a[href^="/api/files/"][href$="/download"]')
    if (!a) return
    const href = a.getAttribute('href') || ''
    if (!href || href === '#') return
    e.preventDefault()
    const name = a.getAttribute('download') || decodeURIComponent((href.split('?')[0].split('/').pop() || 'file'))
    import('react-hot-toast').then(({ default: toast }) => {
      const t = toast.loading('Saving to Downloads…')
      blobOf(href).then(b => b ? saveOnPhone(b, name) : Promise.reject(new Error('This file cannot be saved here')))
        .then(() => toast.success(`Saved: Downloads/Adal Keep/${name}`, { id: t, duration: 5000 }))
        .catch(err => toast.error(err?.response?.data?.error || err.message || 'Not saved', { id: t }))
    })
  }, true)
}
