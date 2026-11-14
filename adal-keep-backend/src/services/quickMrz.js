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
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { fileURLToPath } from 'url'
import { createWorker } from 'tesseract.js'
import { parseTD3, fitLine2 } from './mrz.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MODEL = path.join(ROOT, 'ocrb.traineddata')
const ONLY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<'

// One reader kept warm for 2 minutes after its last page (starting it costs ~0.5 s).
let worker = null, idle = null, chain = Promise.resolve()
function reader() {
  if (!worker) {
    worker = createWorker(['ocrb'], 1, { langPath: ROOT, cachePath: path.join(ROOT, 'data', 'tessdata'), gzip: false })
      .then(async w => { await w.setParameters({ tessedit_pageseg_mode: '6', tessedit_char_whitelist: ONLY }); return w })
    worker.catch(() => { worker = null })
  }
  clearTimeout(idle)
  idle = setTimeout(() => { const w = worker; worker = null; w?.then(x => x.terminate()).catch(() => {}) }, 120000)
  idle.unref?.()
  return worker
}
const read = (file) => { const next = chain.then(async () => (await (await reader()).recognize(file)).data.text || ''); chain = next.catch(() => {}); return next }

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

/** The strip at the bottom of the page (after turning it `angle`), ready to read. */
async function strip(file, angle, from) {
  const turned = await sharp(file).rotate().rotate(angle).toBuffer()
  const meta = await sharp(turned).metadata()
  const top = Math.floor(meta.height * from)
  const out = path.join(os.tmpdir(), `adal_qmrz_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`)
  await sharp(turned).extract({ left: 0, top, width: meta.width, height: meta.height - top })
    .resize({ width: 2000, kernel: 'lanczos3' }).grayscale().normalise().png().toFile(out)
  return out
}

// Upright first (most pages), a taller strip, then upside down and sideways.
const TRIES = [[0, 0.78], [0, 0.66], [180, 0.78], [90, 0.78], [270, 0.78]]

/**
 * A passport read from its MRZ alone, in the shape the classifier answers:
 * { doc_type: 'Passport', confidence, fields, markdown, source } — or null.
 * `tries` limits how many crops are read (the first one is usually enough).
 */
export async function quickMrz(file, { tries = TRIES.length, skip = 0 } = {}) {
  // An upload may have no extension: sharp decides whether it is a picture (a PDF is not read here).
  if (!fs.existsSync(MODEL) || /\.pdf$/i.test(file)) return null
  for (const [angle, from] of TRIES.slice(skip, tries)) {
    let s = null
    try {
      s = await strip(file, angle, from)
      const m = verifiedIn(await read(s))
      if (m) {
        return {
          doc_type: 'Passport', confidence: 0.98, source: 'mrz-ocrb',
          markdown: `${m.mrz_line1}\n${m.mrz_line2}`,
          fields: {
            full_name: `${m.given_names} ${m.surname}`.trim(), surname: m.surname, given_names: m.given_names,
            passport_number: m.passport_number, date_of_birth: m.date_of_birth, date_of_expiry: m.date_of_expiry,
            sex: m.sex, gender: m.sex, nationality: m.nationality_code,
          },
        }
      }
    } catch {} finally { if (s) fs.rm(s, { force: true }, () => {}) }
  }
  return null
}

/** OCR-B readings of a strip already cut out (JEV's box): texts for the caller to verify. */
export async function readStripOcrb(stripFile) {
  if (!fs.existsSync(MODEL)) return []
  const out = path.join(os.tmpdir(), `adal_qmrzs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`)
  try {
    await sharp(stripFile).resize({ width: 2000, kernel: 'lanczos3' }).grayscale().normalise().png().toFile(out)
    return [await read(out)]
  } catch { return [] } finally { fs.rm(out, { force: true }, () => {}) }
}
