/**
 * cvHeader.js — CV pictures that came in from another system.
 *
 *   looksLikeCv(file): a picture that is a CV page ("… APPLICATION FOR
 *     EMPLOYMENT", "CURRICULUM VITAE", "BIO DATA" at its top), not a passport.
 *     Moves put such a picture in "CV", never in "Passport".
 *   commonHeader(files): the agency's header — the top of its CVs that is the
 *     same on every one of them (the name under it differs) — cut out.
 *   harvestHeaders(db, files, source): that header saved for "Add CV template"
 *     (table cv_headers), once per look.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import sharp from 'sharp'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LANG_PATH = path.join(__dirname, '../..')
const CACHE_PATH = path.join(__dirname, '../../data/tessdata')
const IMAGE = /\.(jpe?g|png|webp)$/i

// One small reader kept while pictures come in; it goes after a minute idle.
let worker = null, idle = null, chain = Promise.resolve()
async function reader() {
  clearTimeout(idle)
  if (!worker) {
    const { createWorker } = await import('tesseract.js')
    worker = await createWorker(['eng'], 1, { langPath: LANG_PATH, cachePath: CACHE_PATH, gzip: false })
    await worker.setParameters({ tessedit_pageseg_mode: '6' })
  }
  idle = setTimeout(() => { worker?.terminate().catch(() => {}); worker = null }, 60_000)
  idle.unref?.()
  return worker
}

const CV_WORDS = /APPLICATION\s*FOR\s*EMPLOY|EMPLOYMENT\s*APPLICATION|CURRICULUM|RESUME|BIO\s*-?\s*DATA|COMPLETE\s*NAME|MONTHLY\s*SALARY|CONTRACT\s*PERIOD|POSITION\s*APPLIED/i
const PASSPORT_WORDS = /PASSPORT|PASSEPORT|REPUBLIC|P<[A-Z]{3}/i

/** The words at the top of a picture (its first fifth), upper case. */
async function topWords(file) {
  const meta = await sharp(file).metadata()
  if (!meta.width || !meta.height) return ''
  const h = Math.max(40, Math.floor(meta.height * 0.2))
  const buf = await sharp(file).extract({ left: 0, top: 0, width: meta.width, height: Math.min(h, meta.height) })
    .resize({ width: 1400, withoutEnlargement: false }).grayscale().normalize().png().toBuffer()
  const run = chain.then(async () => (await (await reader()).recognize(buf)).data.text || '')
  chain = run.catch(() => {})
  return String(await run).toUpperCase()
}

/** A CV page, not a passport (a picture only; a PDF is left as it came). */
export async function looksLikeCv(file) {
  if (!IMAGE.test(file)) return false
  try {
    const t = await topWords(file)
    return CV_WORDS.test(t) && !PASSPORT_WORDS.test(t)
  } catch { return false }
}

/**
 * The header the CVs share: the top rows that are the same on all of them.
 * Returns { buf (PNG), height } cut from the first, or null (too few alike).
 */
export async function commonHeader(files) {
  const W = 600
  const imgs = []
  let ratio = 0
  for (const f of files) {
    try {
      const m = await sharp(f).metadata()
      if (!m.width || !m.height) continue
      const r = m.height / m.width
      if (ratio && Math.abs(r - ratio) / ratio > 0.06) continue      // another layout
      ratio ||= r
      const { data, info } = await sharp(f).resize({ width: W }).grayscale().raw().toBuffer({ resolveWithObject: true })
      imgs.push({ f, data, h: info.height, m })
      if (imgs.length >= 6) break
    } catch {}
  }
  if (imgs.length < 2) return null
  const H = Math.min(...imgs.map(i => i.h))
  // Row by row: how far apart the CVs are (the mean difference of each pair).
  const diff = (y) => {
    let s = 0, n = 0
    for (let a = 0; a < imgs.length; a++) for (let b = a + 1; b < imgs.length; b++) {
      const A = imgs[a].data, B = imgs[b].data, o = y * W
      for (let x = 0; x < W; x += 2) { s += Math.abs(A[o + x] - B[o + x]); n++ }
    }
    return s / n
  }
  let end = 0
  for (let y = 0, run = 0; y < Math.floor(H * 0.45); y++) {
    if (diff(y) > 14) { if (++run >= 3) { end = y - 2; break } } else run = 0
  }
  if (end < H * 0.03) return null                                    // nothing shared at the top
  const first = imgs[0]
  const cut = Math.round(end * first.m.height / first.h)
  const buf = await sharp(first.f).extract({ left: 0, top: 0, width: first.m.width, height: Math.max(1, Math.min(cut, first.m.height)) }).png().toBuffer()
  return { buf, height: cut }
}

/** The header of these CVs, kept for "Add CV template" (the same one is kept once). */
export async function harvestHeaders(db, files, source = '', storageDir) {
  const pics = files.filter(f => IMAGE.test(f) && fs.existsSync(f))
  if (pics.length < 2) return null
  const got = await commonHeader(pics)
  if (!got) return null
  const hash = crypto.createHash('sha256').update(got.buf).digest('hex').slice(0, 16)
  if (await db('cv_headers').where('hash', hash).first().catch(() => null)) return null
  fs.mkdirSync(storageDir, { recursive: true })
  const name = `cv-header-${Date.now()}-${hash}.png`
  fs.writeFileSync(path.join(storageDir, name), got.buf)
  const meta = await sharp(got.buf).metadata()
  const [id] = await db('cv_headers').insert({ name: source ? `${source} header` : 'CV header', path: name, source, hash, width: meta.width, height: meta.height, created_at: new Date().toISOString() })
  return Number(id?.id ?? id)
}
