/**
 * The wallpaper: a picture of this device's own (PC or phone), kept on the
 * device (IndexedDB) and shown behind every page, a little darkened so the
 * text stays easy to read. Made small first (at most 1920 px, JPEG): a phone
 * photo does not slow the pages down.
 */
import { idbGet, idbPut } from './idbStore'

const KEY = 'adal-wallpaper'

function apply(url) {
  const root = document.documentElement
  if (url) { root.style.setProperty('--adal-wallpaper', `url("${url}")`); root.classList.add('has-wallpaper') }
  else { root.style.removeProperty('--adal-wallpaper'); root.classList.remove('has-wallpaper') }
}

/** At start: the saved wallpaper, if there is one. */
export async function showWallpaper() {
  try { apply(await idbGet(KEY)) } catch {}
}
export async function currentWallpaper() {
  try { return (await idbGet(KEY)) || null } catch { return null }
}

/** A picture chosen on this device becomes its wallpaper. */
export async function setWallpaper(file) {
  const url = await new Promise((ok, no) => {
    const img = new Image()
    const src = URL.createObjectURL(file)
    img.onload = () => {
      const k = Math.min(1, 1920 / Math.max(img.naturalWidth, img.naturalHeight))
      const c = document.createElement('canvas')
      c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(src)
      ok(c.toDataURL('image/jpeg', 0.82))
    }
    img.onerror = () => { URL.revokeObjectURL(src); no(new Error('That picture could not be opened')) }
    img.src = src
  })
  await idbPut(KEY, url)
  apply(url)
  return url
}

export async function removeWallpaper() {
  await idbPut(KEY, null)
  apply(null)
}
