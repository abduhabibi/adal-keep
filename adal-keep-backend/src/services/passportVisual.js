/**
 * passportVisual.js — the passport's printed details that the bottom lines do not carry
 * (place of birth, date of issue), read on this PC from the page itself: no network.
 *
 * The page above the bottom lines is read once with the English model (about a
 * second on an i5), then:
 *   place of birth  the capitals under the "Place of Birth" label (found by position)
 *   date of issue   the date under / beside the "Date of Issue" label — and only a date
 *                   that makes sense: after her birth, before today, before the expiry
 *                   and exactly 5 or 10 years (less a day) before it. Without a label, the
 *                   one date left over that fits those years. Anything else stays empty:
 *                   a date is never guessed.
 * Every call is best effort: an error is a null result, never a thrown one. ADAL_PASSPORT_VISUAL=0 turns it off.
 */
import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { fileURLToPath } from 'url'
import { createWorker } from 'tesseract.js'
import { cleanPlace, cleanIssue } from './passportDetails.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const IDLE_MS = 10 * 60000
let worker = null, idle = null, chain = Promise.resolve()
const enabled = () => process.env.ADAL_PASSPORT_VISUAL !== '0' && fs.existsSync(path.join(ROOT, 'eng.traineddata'))

function reader() {
  if (!worker) {
    worker = createWorker('eng', 1, { langPath: ROOT, cachePath: path.join(ROOT, 'data', 'tessdata'), gzip: false })
      .then(async w => { await w.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '300' }); return w })
    worker.catch(() => { worker = null })
  }
  clearTimeout(idle)
  idle = setTimeout(() => { const w = worker; worker = null; w?.then(x => x.terminate()).catch(() => {}) }, IDLE_MS)
  idle.unref?.()
  return worker
}
export function warmVisualReader() { return enabled() ? reader().then(() => true, () => false) : Promise.resolve(false) }
export async function stopVisualReader() { clearTimeout(idle); const w = worker; worker = null; await w?.then(x => x.terminate()).catch(() => {}) }
const linesOf = (data) => (data.blocks || []).flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []))

// ---- reading the text ------------------------------------------------------
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12 }
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** Every real date in a text: "16 APR 2007", "16 APR 07", "16/04/2007". */
export function datesIn(text) {
  const out = []
  for (const m of String(text || '').toUpperCase().matchAll(/\b(\d{1,2})[\s./-]*([A-Z]{3,4})[\s./-]*(\d{4}|\d{2})\b/g)) {
    const mo = MONTHS[m[2]]; let y = m[3]
    if (!mo) continue
    if (y.length === 2) y = (Number(y) > 50 ? '19' : '20') + y
    const d = Number(m[1]); if (d >= 1 && d <= 31) out.push(iso(y, mo, d))
  }
  for (const m of String(text || '').matchAll(/\b(\d{1,2})[./-](\d{1,2})[./-](\d{4})\b/g)) {
    const d = Number(m[1]), mo = Number(m[2]); if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) out.push(iso(m[3], mo, d))
  }
  return out
}

const DAY = 86400000
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)
/** Passports run 5 or 10 years, ending the day before the anniversary of the issue (±3 days for a misread digit's rounding). */
export function fitsValidity(issue, expiry) {
  if (!issue || !expiry) return false
  const d = days(issue, expiry)
  return [5, 10].some(y => Math.abs(d - Math.round(y * 365.25) + 1) <= 3)
}

/** The date of issue from the page's lines, or ''. `known` = { date_of_birth, date_of_expiry } from the verified MRZ. */
export function issueFromLines(lines, known = {}) {
  const exp = known.date_of_expiry, p = { date_of_birth: known.date_of_birth, passport_expiry_date: exp }
  const ok = (d) => d && cleanIssue(d, p) && (!exp || fitsValidity(d, exp)) && d !== known.date_of_birth
  const ls = (lines || []).filter(l => String(l.text || '').trim())
  const i = ls.findIndex(l => /issu/i.test(l.text))
  if (i >= 0) {
    const lab = ls[i].bbox
    const same = datesIn(ls[i].text.replace(/.*issu\w*/i, ''))
    const hit = same.find(ok)
    if (hit) return hit
    for (const l of ls.slice(i + 1, i + 4)) {
      const b = l.bbox
      if (b.y0 < lab.y0 || b.x1 < lab.x0 - (lab.x1 - lab.x0) * 0.3 || b.x0 > lab.x1 + (lab.x1 - lab.x0)) continue
      const d = datesIn(l.text).find(ok); if (d) return d
    }
  }
  // No usable label: a leftover date that fits the passport's years exactly, when there is just one.
  const left = [...new Set(ls.flatMap(l => datesIn(l.text)))].filter(d => d !== known.date_of_birth && d !== exp && ok(d) && exp)
  return left.length === 1 ? left[0] : ''
}

const LABEL = /place\s*of\s*birth|birth\s*place|of\s*birth/i
const NOT_A_PLACE = /^(ETH|ETHIOPIA|ETHIOPIAN|FEMALE|MALE|PASSPORT|NATIONALITY|SEX|DATE|ISSUE|AUTHORITY|MAIN|DEPARTMENT|IMMIGRATION|ICS|INVEA|JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)$/
function capitals(text) {
  for (const run of String(text || '').split(/[^A-Z'\- ]+/)) {
    const words = run.trim().split(/\s+/).filter(w => w.length >= 4 && !NOT_A_PLACE.test(w))
    if (words.length) return words.slice(0, 2).join(' ')
  }
  return ''
}
/** The place of birth: the capitals on the line right under its label (same rule as the phone app's passportText.js). */
export function placeFromLines(lines) {
  const ls = (lines || []).filter(l => String(l.text || '').trim())
  const i = ls.findIndex(l => LABEL.test(l.text))
  if (i < 0) return ''
  const lab = ls[i].bbox
  for (const l of ls.slice(i + 1, i + 4)) {
    const b = l.bbox
    if (b.y0 < lab.y0 || b.x1 < lab.x0 - (lab.x1 - lab.x0) * 0.3) continue
    const v = cleanPlace(capitals(l.text)); if (v) return v
  }
  return ''
}

/**
 * The page's printed lines (above the bottom lines), turned `turn` degrees: [{ text, bbox }].
 * Started by the scan at once, alongside the reading of the bottom lines (for an upright page).
 * `deadline` (Date.now() value): a read that has not started by then does not start.
 */
export function pageLines(file, turn = 0, { deadline = Infinity } = {}) {
  if (!enabled() || /\.pdf$/i.test(file)) return Promise.resolve(null)
  const run = chain.then(async () => {
    if (Date.now() > deadline) return null
    const { data, info } = await sharp(file).rotate().rotate(turn).resize({ width: 2400, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true })
    // The page above the bottom lines, the top header left out; ~1400 px wide is enough for the printed words.
    const top = Math.floor(info.height * 0.1), bottom = Math.floor(info.height * 0.8)
    const png = await sharp(data, { raw: { width: info.width, height: info.height, channels: info.channels } })
      .extract({ left: 0, top, width: info.width, height: bottom - top })
      .resize({ width: 1400 }).grayscale().normalise().png({ compressionLevel: 1 }).toBuffer()
    return linesOf((await (await reader()).recognize(png, {}, { blocks: true })).data)
  }).catch((e) => { console.warn('[passport visual]', e.message); return null })
  chain = run.then(() => {}, () => {})
  return run
}

/**
 * { place_of_birth, date_of_issue } read from the page (either may be ''), or null when nothing could be read.
 * `quick` is quickMrz's answer: its fields and how far the page was turned. `lines` (optional): pageLines()
 * started earlier for turn 0; used when the page proved upright, else the page is read again turned.
 */
export async function readVisual(file, quick, { deadline = Infinity, lines = null } = {}) {
  if (!enabled() || /\.pdf$/i.test(file) || !quick?.fields) return null
  const got = (!quick.turn && lines ? await lines : null) || await pageLines(file, quick.turn || 0, { deadline })
  if (!got) return null
  const f = quick.fields
  const place = placeFromLines(got)
  const issue = issueFromLines(got, { date_of_birth: f.date_of_birth, date_of_expiry: f.date_of_expiry })
  return place || issue ? { place_of_birth: place, date_of_issue: issue } : null
}
