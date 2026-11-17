/**
 * The passport read on the phone itself — no PC, no internet, a few seconds
 * (asked on 2026-11-17: "extract through OCR and find the birth place by its
 * position from the bottom of the passport, it will be faster").
 *
 *   1. the two bottom lines (MRZ) in the OCR-B font, from the bottom third of
 *      the page (upright, else upside down); only a reading whose check
 *      digits all verify is taken — name, number, birth, sex, expiry
 *   2. the place of birth: from where the MRZ is, the band of the page where
 *      the "Place of Birth" label sits on our passports (measured), made
 *      larger and read in English; the line under the label is the place.
 *      Not found: left empty (the person types it, or the PC fills it later).
 *
 * Measured on 30 of our passports (2026-11-17): MRZ verified on 26, their
 * numbers and births the same as saved; the place read on 16, 15 of them the
 * same as saved. Uses tesseract.js inside the app (www/tess: the worker, the
 * engine and the two models, vite.config.js).
 */
import { mrzIn, fieldsOf, placeFromLines } from './passportText'

const base = () => new URL('/tess/', location.href).href
let readers = null
function workers() {
  if (!readers) {
    readers = (async () => {
      const { createWorker } = await import('tesseract.js')
      const opts = { workerPath: base() + 'worker.min.js', corePath: base() + 'tesseract-core-simd-lstm.wasm.js', langPath: base().replace(/\/$/, ''), gzip: false, workerBlobURL: false, cacheMethod: 'none' }
      const ocrb = await createWorker('ocrb', 1, opts)
      await ocrb.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<' })
      const eng = await createWorker('eng', 1, opts)
      await eng.setParameters({ tessedit_pageseg_mode: '3' })
      return { ocrb, eng }
    })()
    readers.catch(() => { readers = null })
  }
  return readers
}
/** Start the readers early (the "add profile" page opens): the first read is then quicker. */
export const warmPassportReader = () => { workers().catch(() => {}) }

async function bitmapOf(blob) {
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }) } catch {}
  const url = URL.createObjectURL(blob)
  try { const img = new Image(); img.src = url; await img.decode(); return img } finally { setTimeout(() => URL.revokeObjectURL(url), 2000) }
}

/** The picture turned (0 / 180), as a canvas. */
function turned(bmp, angle) {
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height
  const x = c.getContext('2d')
  if (angle === 180) { x.translate(c.width, c.height); x.rotate(Math.PI) }
  x.drawImage(bmp, 0, 0)
  return c
}

/** A piece of the picture, made `width` wide, grey and its contrast stretched (as the PC's sharp normalise). */
function piece(src, sx, sy, sw, sh, width) {
  const k = width / sw
  const c = document.createElement('canvas'); c.width = Math.round(sw * k); c.height = Math.max(1, Math.round(sh * k))
  const x = c.getContext('2d', { willReadFrequently: true })
  x.imageSmoothingQuality = 'high'
  x.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height)
  const im = x.getImageData(0, 0, c.width, c.height), d = im.data
  let lo = 255, hi = 0
  for (let i = 0; i < d.length; i += 4) { const g = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; d[i] = g; if (g < lo) lo = g; if (g > hi) hi = g }
  const span = Math.max(1, hi - lo)
  for (let i = 0; i < d.length; i += 4) { const v = ((d[i] - lo) * 255) / span; d[i] = d[i + 1] = d[i + 2] = v }
  x.putImageData(im, 0, 0)
  return c
}
const linesOf = (data) => (data.blocks || []).flatMap(b => b.paragraphs.flatMap(p => p.lines))

/**
 * A passport picture → what PassportFirst gets from a reader, or null when its
 * bottom lines do not verify (a PDF, a blurred picture: the PC reads it instead).
 */
export async function readPassportHere(file) {
  if (!file || !/^image\//.test(file.type || '') && !/\.(jpe?g|png|webp|bmp)$/i.test(file.name || '')) return null
  const t0 = performance.now()
  const { ocrb, eng } = await workers()
  const bmp = await bitmapOf(file)
  for (const angle of [0, 180]) {
    const page = turned(bmp, angle)
    const top = Math.floor(page.height * 0.66)
    const scale = 2000 / page.width
    const strip = piece(page, 0, top, page.width, page.height - top, 2000)
    const ls = linesOf((await ocrb.recognize(strip, {}, { blocks: true, text: true })).data).filter(l => l.text.replace(/\s+/g, '').length >= 30)
    const m = mrzIn(ls.map(l => l.text).join('\n'))
    if (!m) continue
    const b = ls[m.line].bbox
    const mrzTop = top + b.y0 / scale, mrzLeft = b.x0 / scale, mrzW = (b.x1 - b.x0) / scale
    // The band where "Place of Birth" sits, measured from the MRZ.
    let place = ''
    try {
      const L = Math.max(0, Math.round(mrzLeft + 0.22 * mrzW)), T = Math.max(0, Math.round(mrzTop - 0.44 * mrzW))
      const Bt = Math.max(T + 10, Math.round(mrzTop - 0.17 * mrzW))
      const band = piece(page, L, T, page.width - L, Bt - T, 1800)
      place = placeFromLines(linesOf((await eng.recognize(band, {}, { blocks: true })).data))
    } catch {}
    const fields = { ...fieldsOf(m), ...(place ? { place_of_birth: place } : {}) }
    return {
      doc_type: 'Passport', verified: true, source: 'phone', ms: Math.round(performance.now() - t0),
      offline: true, file, filename: file.name || 'passport.jpg',
      fields, markdown: `${m.mrz_line1}\n${m.mrz_line2}`,
    }
  }
  return null
}
