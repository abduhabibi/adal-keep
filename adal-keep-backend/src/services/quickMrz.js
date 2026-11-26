/**
 * quickMrz.js — the passport's two bottom lines (MRZ) read on this PC in about
 * a second, before anything else is asked (JEV, Gemini): free and fast.
 *
 * The lines are printed in the OCR-B font, so they are read with a model made
 * for it (ocrb.traineddata, Apache 2.0: github.com/Shreeshrii/tessdata_ocrb —
 * 12 of 13 of our passports read right, 0.7 s each; the English model: 3 of 13).
 * Only a reading whose ICAO check digits all verify is taken (number, birth,
 * expiry and the overall digit); the name is the MRZ's own. Anything else goes
 * on to the usual readers as before.
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { fileURLToPath } from 'url'
import { createWorker } from 'tesseract.js'
import { parseTD3, fitLine2 } from './mrz.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODEL = path.join(ROOT, 'ocrb.traineddata')
const WARM = path.join(path.dirname(fileURLToPath(import.meta.url)), 'warmMrz.png')
const ONLY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'

// One reader kept warm for 10 minutes after its last page (starting it costs
// ~0.5 s): the "new profile" page warms it when it opens (warmMrzReader).
const IDLE_MS = 10 * 60000
let worker = null, idle = null, chain = Promise.resolve(), busy = 0
function reader() {
  if (!worker) {
    worker = createWorker(['ocrb'], 1, { langPath: ROOT, cachePath: path.join(ROOT, 'data', 'tessdata'), gzip: false })
      .then(async w => { await w.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: ONLY, user_defined_dpi: '300' }); return w })
    worker.catch(() => { worker = null })
  }
  clearTimeout(idle)
  idle = setTimeout(function letGo() { if (busy) { idle = setTimeout(letGo, 5000); idle.unref?.(); return }   // never under a read in progress
    const w = worker; worker = null; w?.then(x => x.terminate()).catch(() => {}) }, IDLE_MS)
  idle.unref?.()
  return worker
}
/** Start the reader now (a passport is about to come): the first read skips its start. */
export function warmMrzReader() {
  if (!fs.existsSync(MODEL)) return Promise.resolve(false)
  // The first page read is ~2x slower than the next ones (the engine's buffers fill on first use):
  // one throwaway read of a small sample strip now, while nobody waits.
  return reader().then(async () => {
    // warmMrz.png: a strip of the made-up ICAO specimen page (no real person).
    const dummy = fs.existsSync(WARM) ? await sharp(WARM).resize({ width: 2000 }).png({ compressionLevel: 1 }).toBuffer() : null
    if (dummy) await read(dummy).catch(() => {})
    return true
  }, () => false)
}
/** Let the reader go now (tests, a closing app). */
export async function stopMrzReader() {
  clearTimeout(idle)
  await chain.catch(() => {})   // the reads already waiting finish first (a terminated worker cannot be posted to)
  const w = worker; worker = null
  await w?.then(x => x.terminate()).catch(() => {})
}
// A picture (a PNG buffer) or a file read; one at a time on the one reader.
const read = (img) => {
  const next = chain.then(async () => {
    busy++
    try {
      for (let again = 0; ; again++) {
        try { return (await (await reader()).recognize(img)).data.text || '' }
        // The worker was stopped under this read (an app closing, a test): one new worker, once; else the read is a failure.
        catch (e) { if (again || !/postMessage|terminated|null/i.test(String(e?.message))) throw e; worker = null }
      }
    } finally { busy-- }
  })
  chain = next.catch(() => {})
  return next
}

/** The verified MRZ in an OCR text, or null. */
export function verifiedIn(text) {
  const ls = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, '').toUpperCase()).filter(l => l.length >= 30)
  for (let i = 0; i < ls.length - 1; i++) {
    if (!/^P[A-Z<]/.test(ls[i])) continue
    const m = parseTD3(`${ls[i].padEnd(44, '<').slice(0, 44)}\n${fitLine2(ls[i + 1]).padEnd(44, '<').slice(0, 44)}`)
    if (!m?.overall_verified || !m.passport_number_verified || !m.date_of_birth_verified || !m.date_of_expiry_verified) continue
    if (!/^[A-Z ]{2,}$/.test(m.surname || '') || !/^[A-Z ]{2,}$/.test(m.given_names || '')) continue
    return m
  }
  return null
}

/**
 * The page decoded ONCE, at the size the strips need (JPEG pictures are shrunk while
 * they are decoded: a 12-megapixel photo costs a fraction of a full decode), turned
 * upright by its EXIF. Every crop below is cut from this one buffer.
 */
async function page(file) {
  const { data, info } = await sharp(file).rotate().resize({ width: 2400, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true })
  return { raw: data, w: info.width, h: info.height, ch: info.channels }
}

/** The bottom of the page (after turning it `angle`) from `from` down, `width` px wide, ready to read: a PNG buffer. */
async function strip(pg, angle, from, width = 2000) {
  let img = sharp(pg.raw, { raw: { width: pg.w, height: pg.h, channels: pg.ch } })
  if (angle) img = sharp(await img.rotate(angle).raw().toBuffer(), { raw: { width: angle === 180 ? pg.w : pg.h, height: angle === 180 ? pg.h : pg.w, channels: pg.ch } })
  const w = angle === 90 || angle === 270 ? pg.h : pg.w, h = angle === 90 || angle === 270 ? pg.w : pg.h
  const top = Math.floor(h * from)
  return img.extract({ left: 0, top, width: w, height: h - top })
    .resize({ width, kernel: 'lanczos3' }).grayscale().normalise().png({ compressionLevel: 1 }).toBuffer()
}

// Upright first (most pages), a taller strip, then upside down and sideways.
const TRIES = [[0, 0.78], [0, 0.66], [180, 0.78], [90, 0.78], [270, 0.78]]
const TURNS = [180, 90, 270]

/**
 * A passport read from its MRZ alone, in the shape the classifier answers:
 * { doc_type: 'Passport', confidence, fields, markdown, source } — or null.
 *   tries    how many of the crops are read (the first one is usually enough)
 *   skip     crops to leave out at the start
 *   deadline Date.now() value after which no further crop is started (a scan
 *            has a time to answer in; a crop already being read finishes)
 *   onStep   'reading' | 'checking' for the page's progress text
 *   skews    angles (degrees) to try when every crop failed but something that looks like bottom lines was seen (25+ '<'
 *            fillers were read in some crop: a photographed page that is a little crooked); null = never
 *   minFill  fast "no" (for files that are probably not passports): a crop whose reading shows fewer than this many '<'
 *            (the filler of the bottom lines; a real strip has 25+) is not tried again in another way. 0 = try everything.
 * A page that is not upright is not read crop by crop: each turn is first probed at
 * a small size (a third of the work), the most MRZ-like one is read in full first.
 */
export async function quickMrz(file, { tries = TRIES.length, skip = 0, deadline = Infinity, onStep = () => {}, minFill = 0, skews = null } = {}) {
  // An upload may have no extension: sharp decides whether it is a picture (a PDF is not read here).
  if (!fs.existsSync(MODEL) || /\.pdf$/i.test(file)) return null
  onStep('reading')
  let pg
  try { pg = await page(file) } catch { return null }
  const done = (m, turn = 0) => ({
    doc_type: 'Passport', confidence: 0.98, source: 'mrz-ocrb', turn,   // turn: how far the page was turned to read it
    markdown: `${m.mrz_line1}\n${m.mrz_line2}`,
    fields: {
      full_name: `${m.given_names} ${m.surname}`.trim(), surname: m.surname, given_names: m.given_names,
      passport_number: m.passport_number, date_of_birth: m.date_of_birth, date_of_expiry: m.date_of_expiry,
      sex: m.sex, gender: m.sex, nationality: m.nationality_code,
    },
  })
  let lastFill = 0, maxFill = 0
  const attempt = async (angle, from) => {
    const mine = await strip(pg, angle, from).catch(() => null)
    if (!mine) return null
    try {
      const text = await read(mine)
      lastFill = (text.match(/</g) || []).length
      if (lastFill > maxFill) maxFill = lastFill
      onStep('checking')
      const m = verifiedIn(text)
      onStep('reading')
      return m ? done(m, angle) : null
    } catch { return null }
  }
  const list = TRIES.slice(skip, tries)
  const upright = list.filter(([a]) => a === 0), turned = list.filter(([a]) => a !== 0)
  let uprightFill = 0
  for (const [a, f] of upright.slice(0, 1)) { const r = await attempt(a, f); uprightFill = lastFill; if (r) return r }
  if (Date.now() > deadline) return null
  // Not read upright: probe the turns small, the one with the most '<' (the filler of the MRZ) first.
  const angles = turned.map(([a]) => a).filter((a, i, all) => all.indexOf(a) === i)
  const scored = []
  for (const a of angles) {
    if (Date.now() > deadline) return null
    const t = await strip(pg, a, 0.78, 900).then(read, () => '')
    const n = (t.match(/</g) || []).length
    scored.push([a, n])
    if (n >= 15) break   // a page the right way up shows 25+ fillers at this size; a wrong way shows ~0: the rest is not probed
  }
  scored.sort((x, y) => y[1] - x[1])
  for (const [a, n] of scored) {
    if (n < minFill) continue   // no sign of bottom lines this way up: not read in full
    if (Date.now() > deadline) return null
    const r = await attempt(a, 0.78); if (r) return r
  }
  // Last: the taller upright strip (a crooked photo with the lines higher up).
  for (const [a, f] of upright.slice(1)) { if (Date.now() > deadline || uprightFill < minFill) return null; const r = await attempt(a, f); if (r) return r }
  // A crooked page: the lines were seen (fillers read) but did not verify — turned a few degrees and read again.
  if (skews && maxFill >= 6) {
    for (const k of skews) {
      if (Date.now() > deadline) return null
      try {
        const { data, info } = await sharp(pg.raw, { raw: { width: pg.w, height: pg.h, channels: pg.ch } }).rotate(k, { background: '#ffffff' }).raw().toBuffer({ resolveWithObject: true })
        const sk = { raw: data, w: info.width, h: info.height, ch: info.channels }
        for (const from of [0.74, 0.62]) {
          const text = await strip(sk, 0, from).then(read)
          const m = verifiedIn(text); if (m) return done(m, 0)
        }
      } catch {}
    }
  }
  return null
}

/** OCR-B readings of a strip already cut out (JEV's box): texts for the caller to verify. */
export async function readStripOcrb(stripFile) {
  if (!fs.existsSync(MODEL)) return []
  try {
    return [await read(await sharp(stripFile).resize({ width: 2000, kernel: 'lanczos3' }).grayscale().normalise().png({ compressionLevel: 1 }).toBuffer())]
  } catch { return [] }
}
