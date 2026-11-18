/**
 * viewCopy.js — the light copy of a document that goes online (Telegram) for
 * the Companion and the phones to look at. The original stays on the main PC
 * (and in the Telegram backup); online only needs something clear to read and
 * print, and Ethiopian lines are slow.
 *
 *   picture  → at most 1600 px, JPEG ~72 % (a 4 MB phone photo: ~200 KB)
 *   PDF      → up to 500 KB as it is; bigger: each page drawn at ~1500 px
 *              JPEG and put back into a PDF (scans — passports, medicals — are
 *              pictures anyway); more than 12 pages: as it is
 *   other    → as it is
 * A copy that is not smaller than the original is never used.
 */
import { PassThrough } from 'stream'

const MAX_PX = 1600
const PDF_KEEP = 500 * 1024
const PDF_PAGES = 12

async function smallPicture(buf) {
  const sharp = (await import('sharp')).default
  return sharp(buf, { failOn: 'none' }).rotate()
    .resize({ width: MAX_PX, height: MAX_PX, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 72, mozjpeg: true }).toBuffer()
}

async function smallPdf(buf) {
  const mupdf = await import('mupdf')
  const sharp = (await import('sharp')).default
  const doc = mupdf.Document.openDocument(buf, 'application/pdf')
  try {
    const n = doc.countPages()
    if (!n || n > PDF_PAGES) return null
    const pages = []
    for (let i = 0; i < n; i++) {
      const page = doc.loadPage(i)
      const [x0, y0, x1, y1] = page.getBounds()
      const zoom = Math.min(3, 1500 / Math.max(x1 - x0, y1 - y0, 1))
      const pix = page.toPixmap([zoom, 0, 0, zoom, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
      pages.push(await sharp(Buffer.from(pix.asPNG())).jpeg({ quality: 65, mozjpeg: true }).toBuffer())
      pix.destroy?.(); page.destroy?.()
    }
    const imageToPdf = (await import('image-to-pdf')).default
    const out = new PassThrough(), parts = []
    out.on('data', (c) => parts.push(c))
    await new Promise((resolve, reject) => { imageToPdf(pages).pipe(out).on('finish', resolve).on('error', reject) })
    return Buffer.concat(parts)
  } finally {
    doc.destroy?.()
  }
}

/** { buf, mimetype, small } — the copy to send online (small: true when it was made lighter). */
export async function viewCopy(buf, mimetype = '', name = '') {
  const type = String(mimetype || '').toLowerCase()
  const isPdf = type === 'application/pdf' || /\.pdf$/i.test(name)
  try {
    let out = null, outType = type
    if (/^image\/(jpeg|jpg|png|webp|heic|heif|tiff|bmp)$/.test(type)) { out = await smallPicture(buf); outType = 'image/jpeg' }
    else if (isPdf && buf.length > PDF_KEEP) { out = await smallPdf(buf); outType = 'application/pdf' }
    if (out && out.length < buf.length * 0.9) return { buf: out, mimetype: outType, small: true }
  } catch (e) {
    console.warn(`[cloud] light copy of ${name || 'a document'} failed, the original goes: ${e.message}`)
  }
  return { buf, mimetype: mimetype || 'application/octet-stream', small: false }
}
