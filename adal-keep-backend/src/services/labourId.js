/**
 * labourId.js — the Labour ID printed in red across the top of a passport
 * (asked on 2026-11-18). Found and read on this PC, no AI call:
 *
 *  1. The red ink is found by its colour (bright red, far redder than green
 *     or blue) in the top part of the passport picture.
 *  2. That red block is read with the local OCR (Tesseract, eng), letters and
 *     digits only, and checked against the usual shape (EF11213247).
 *  3. The red block is painted over with the colour around it, so the
 *     passport comes out without the number, and the number is saved as its
 *     own picture.
 *
 * Returns null when there is no red text: the passport is then left as it is.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import sharp from 'sharp'
import { createWorker } from 'tesseract.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const BAND = 0.3          // the labour ID sits in the top 30% of the passport
const MIN_RED = 150       // fewer red pixels than this is not printed text

const isRed = (r, g, b) => r > 150 && r - g > 70 && r - b > 70

let worker = null
function ocr() {
  if (!worker) {
    worker = createWorker(['eng'], 1, { langPath: ROOT, cachePath: path.join(ROOT, 'data', 'tessdata'), gzip: false })
      .then(async w => { await w.setParameters({ tessedit_pageseg_mode: '7', tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' }); return w })
    worker.catch(() => { worker = null })
  }
  return worker
}

/** Frees the OCR reader (tests, shutdown). */
export async function stopLabourOcr() {
  const w = worker; worker = null
  if (w) await (await w).terminate().catch(() => {})
}

/** The red block: its box in pixels, or null. Percentiles drop stray specks. */
function redBox(raw, w, h) {
  const xs = [], ys = []
  const bandH = Math.floor(h * BAND)
  for (let y = 0; y < bandH; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 3
    if (isRed(raw[i], raw[i + 1], raw[i + 2])) { xs.push(x); ys.push(y) }
  }
  if (xs.length < MIN_RED) return null
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b)
  const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))]
  const pad = 6
  return {
    left: Math.max(0, q(xs, 0.002) - pad), right: Math.min(w, q(xs, 0.998) + pad + 1),
    top: Math.max(0, q(ys, 0.002) - pad), bottom: Math.min(h, q(ys, 0.998) + pad + 1),
  }
}

/** What the block says: red ink to black, the rest to white, read as one line. */
async function readBlock(raw, w, box) {
  const bw = box.right - box.left, bh = box.bottom - box.top
  const mask = Buffer.alloc(bw * bh)
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    const i = ((box.top + y) * w + box.left + x) * 3
    mask[y * bw + x] = isRed(raw[i], raw[i + 1], raw[i + 2]) ? 0 : 255
  }
  const png = await sharp(mask, { raw: { width: bw, height: bh, channels: 1 } }).resize({ width: bw * 3 }).png().toBuffer()
  const { data } = await (await ocr()).recognize(png)
  const text = String(data?.text || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  const m = text.match(/[A-Z]{1,3}\d{5,10}/)
  return m ? m[0] : null
}

/** Paints the box with the median colour of the ring around it. */
function paint(raw, w, h, box) {
  const reds = [[], [], []]
  for (let y = Math.max(0, box.top - 6); y < Math.min(h, box.bottom + 6); y++) for (let x = Math.max(0, box.left - 6); x < Math.min(w, box.right + 6); x++) {
    if (x >= box.left && x < box.right && y >= box.top && y < box.bottom) continue
    const i = (y * w + x) * 3
    reds[0].push(raw[i]); reds[1].push(raw[i + 1]); reds[2].push(raw[i + 2])
  }
  const med = reds.map(a => (a.sort((p, q) => p - q), a[Math.floor(a.length / 2)] ?? 255))
  const out = Buffer.from(raw)
  for (let y = box.top; y < box.bottom; y++) for (let x = box.left; x < box.right; x++) {
    const i = (y * w + x) * 3
    out[i] = med[0]; out[i + 1] = med[1]; out[i + 2] = med[2]
  }
  return out
}

/**
 * The labour ID of a passport picture at `file`. Writes `<dir>/labour-id.jpg`
 * (the number as printed) and `<dir>/passport-clean.jpg` (the passport without
 * it). Returns { text, file, passport } or null when there is no red text.
 */
export async function labourIdFrom(file, dir) {
  const { data, info } = await sharp(file).rotate().removeAlpha().raw().toBuffer({ resolveWithObject: true })
  const w = info.width, h = info.height
  const box = redBox(data, w, h)
  if (!box) return null
  const text = await readBlock(data, w, box).catch(() => null)
  const crop = path.join(dir, 'labour-id.jpg')
  await sharp(data, { raw: { width: w, height: h, channels: 3 } }).extract({ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }).jpeg({ quality: 93 }).toFile(crop)
  const clean = path.join(dir, 'passport-clean.jpg')
  await sharp(paint(data, w, h, box), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 93 }).toFile(clean)
  return { text, file: crop, passport: clean }
}
