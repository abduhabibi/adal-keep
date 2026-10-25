/**
 * jevClassifier.js — JEV (TypeSafe system_one) looks at a document image and
 * answers TYPED questions. It never writes free text, so nothing has to be
 * parsed or guessed: every answer is something the system already knows how
 * to act on.
 *
 *   doc_type  choice  one of the profile field names (Passport, Slip, ...)
 *                     → which field the file is stored in
 *   readable  noul    probability the page is sharp and complete
 *                     → an unreadable passport raises "passport_unreadable"
 *   person    choice  which existing profile the document is about, or none
 *                     → the file is filed on that profile
 *   mrz       box     where the two machine-readable lines are (passports)
 *                     → that strip is cropped and read locally; the MRZ check
 *                       digits prove the passport number, name and dates
 *
 * One request per file, image included. The caller decides with thresholds
 * (JEV_MIN_CONFIDENCE, JEV_PROFILE_MIN_CONFIDENCE) and falls back to the
 * existing Gemini / MinerU path when JEV is unsure or unavailable.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { jevKeys, withJevKey } from './jev/keys.js'

export const JEV_DOC_TYPES = {
  'Passport': 'Ethiopian passport data page: bilingual, PASSPORT heading, photo, two machine-readable lines with <<< at the bottom.',
  'Government ID': 'Ethiopian kebele ID or national ID card.',
  'Photo': 'A personal photograph of one person (head and shoulders), no printed document text around it.',
  'Medical Report': 'Hospital or clinic medical report: fit for work, blood group, chest x-ray, lab results.',
  'Police Clearance': 'Police clearance / Certificate of Good Conduct.',
  'COC': 'Certificate of competence (COC).',
  'Visa': 'Entry visa page or visa document.',
  'Saudi-letter': 'Letter from a Saudi embassy or consulate.',
  'Musaned': 'Document from the Saudi Musaned platform.',
  'Broker ID': 'Identification card of a broker or agent.',
  'Ticket-ongoing': 'Airline ticket or boarding pass for travel abroad.',
  'Ticket-deported': 'Airline ticket that says the person was deported.',
  'Labour ID': 'Labour ID card.',
  'Slip': 'Bank or payment receipt: CBE, Birr, transfer, Order ID, debit/credit account.',
  'Experience Form': 'Employment experience letter or form.',
  'Insurance': 'Insurance policy or certificate.',
  'CV': 'Curriculum vitae / resume of a worker.',
  'Contract': 'Employment contract between an employer and a worker.',
  'Employee ID': 'Employee ID card.',
  'Client ID': 'Client ID card.',
  'other': 'None of the above, a screenshot, or not a document at all.',
}

// JEV refuses pictures larger than this on either side ("Invalid image
// dimensions" at 1600; 1568 is accepted — checked 2026-10-20).
const JEV_MAX_SIDE = 1568

const IMAGE_IN = /\.(jpe?g|png|webp|bmp|gif|tiff?)$/i

export function jevReady() {
  if (String(process.env.JEV_CLASSIFY || '').toLowerCase() === 'false') return false
  return jevKeys().length > 0
}

// The API calls go through withJevKey: a key with no credits left hands over
// to the next one (TYPESAFE_API_KEYS).
let _client = null
async function client() {
  if (_client) return _client
  const sdk = await import('@typesafe-ai/sdk')
  const make = (sdk, key) => new sdk.TypeSafeClient({
    apiKey: key,
    defaultModel: process.env.JEV_MODEL || undefined,
    // JEV answers in 1–3 s when it is up; waiting longer only holds the file up.
    timeout: Number(process.env.JEV_TIMEOUT_MS || 8000),
    // One try: when JEV is down, Gemini answers instead of waiting for retries.
    retry: { maxRetries: 0 },
    // Image input is opt-in on the API.
    defaultHeaders: { 'TypeSafe-Danger-Zone-Images': 'true' },
  })
  _client = {
    sdk,
    api: { systemOne: (...args) => withJevKey('classify', make, (api) => api.systemOne(...args)) },
  }
  return _client
}

/**
 * The page as a PNG/JPEG buffer JEV accepts (it rejects WebP/GIF/PDF):
 * first page of a PDF, other formats converted, large scans scaled down.
 * Returns { buffer, width, height, tmp } — tmp is a file to delete, if any.
 */
async function pageImage(filePath) {
  let src = filePath
  let tmp = null
  if (/\.pdf$/i.test(filePath)) {
    const mupdf = await import('mupdf')
    const doc = mupdf.Document.openDocument(fs.readFileSync(filePath), 'application/pdf')
    if (doc.countPages() === 0) throw new Error('empty PDF')
    const pix = doc.loadPage(0).toPixmap([2, 0, 0, 2, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
    tmp = path.join(os.tmpdir(), `adal-jev-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
    fs.writeFileSync(tmp, Buffer.from(pix.asPNG()))
    src = tmp
  } else if (!IMAGE_IN.test(filePath)) {
    throw new Error(`not an image or PDF: ${path.extname(filePath)}`)
  }
  const { data, info } = await sharp(src).rotate()
    .resize({ width: JEV_MAX_SIDE, height: JEV_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
    .png().toBuffer({ resolveWithObject: true })
  return { buffer: data, width: info.width, height: info.height, tmp, src }
}

/**
 * Ask JEV about one document.
 * @param {string} filePath
 * @param {{ profiles?: Array<{id:number, full_name:string, passport_number?:string, labor_id?:string}> }} opts
 */
export async function classifyWithJev(filePath, { profiles = [] } = {}) {
  const t0 = Date.now()
  const { sdk, api } = await client()
  const page = await pageImage(filePath)
  try {
    const typeCriteria = { ...JEV_DOC_TYPES }
    const questions = {
      doc_type: sdk.choice('What kind of document is this image?', typeCriteria),
      readable: sdk.noul('Is the document sharp, well lit and complete, so every printed word can be read?'),
      mrz: sdk.box('The two machine-readable lines (letters, digits and <<< fillers) at the bottom of a passport data page.'),
    }
    // "Who is this about?" — the answer is a profile id, not a name to parse.
    const people = profiles.filter(p => p.full_name && p.full_name !== 'Unknown').slice(0, 150)
    if (people.length) {
      const crit = { none: 'The document is about nobody in this list, or names no person.' }
      for (const p of people) {
        crit[`p${p.id}`] = [p.full_name, p.passport_number && `passport ${p.passport_number}`, p.labor_id && `labor ID ${p.labor_id}`]
          .filter(Boolean).join(', ')
      }
      questions.person = sdk.choice('Which person is this document about? Match the printed name, passport number or ID.', crit)
    }

    // Box questions (the MRZ) need the jev-preview model (SDK 0.7 README);
    // the default model refuses the whole request with "Invalid request".
    const res = await api.systemOne({ state: { document: sdk.image(page.buffer) }, questions, model: process.env.JEV_BOX_MODEL || 'jev-preview' })
    const a = res.answers || {}
    const personLabel = a.person?.choice
    return {
      doc_type: a.doc_type?.choice || 'other',
      confidence: Number(a.doc_type?.confidence ?? 0),
      probabilities: a.doc_type?.probabilities || {},
      readable: typeof a.readable?.noul === 'number' ? a.readable.noul : null,
      mrzBox: a.mrz?.box || null,
      mrzBoxConfidence: a.mrz?.confidence ?? null,
      person: personLabel && personLabel !== 'none'
        ? { id: Number(personLabel.slice(1)), confidence: Number(a.person.confidence ?? 0) }
        : null,
      model: res.model,
      ms: Date.now() - t0,
      image: { width: page.width, height: page.height },
      _pageSrc: page.src, // kept until cropMrz runs, then deleted by release()
      _tmp: page.tmp,
    }
  } catch (e) {
    if (page.tmp) try { fs.unlinkSync(page.tmp) } catch {}
    throw e
  }
}

/**
 * The MRZ name has no check digit and OCR turns its "<" separators into
 * letters, so the system offers JEV the few possible readings and JEV picks
 * the one printed on the passport (or none). Returns { name, confidence } or null.
 */
export async function pickPrintedName(result, candidates) {
  if (!candidates.length) return null
  const { sdk, api } = await client()
  const { data } = await sharp(result._pageSrc).rotate()
    .resize({ width: JEV_MAX_SIDE, height: JEV_MAX_SIDE, fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
  const crit = { none: 'None of these is the name printed on the passport.' }
  candidates.forEach((c, i) => { crit[`n${i}`] = c })
  const res = await api.systemOne({
    state: { document: sdk.image(data) },
    questions: { name: sdk.choice('Which of these is exactly the person\'s name printed on this passport (given names, then surname)?', crit) },
  })
  const pick = res.answers?.name
  if (!pick || pick.choice === 'none') return null
  return { name: candidates[Number(pick.choice.slice(1))], confidence: Number(pick.confidence ?? 0) }
}

// No credits / bad key: stop asking for a while instead of failing every run.
let _lookPausedUntil = 0
let _lookWhy = ''

/** Why the last lookAtPage() got no answer ('' when JEV answered). */
export function lookUnavailableReason() {
  if (!jevReady()) return 'JEV is off (no TypeSafe key)'
  return _lookWhy
}

/**
 * Show JEV a screenshot and ask yes/no questions about it.
 * `questions` is { name: 'question text' }. Returns { name: probability 0..1 }
 * or null when JEV is off, out of credits or did not answer.
 */
export async function lookAtPage(png, questions) {
  if (!jevReady() || Date.now() < _lookPausedUntil) return null
  _lookWhy = ''
  try {
    const { sdk, api } = await client()
    const img = await sharp(png).resize({ width: JEV_MAX_SIDE, height: JEV_MAX_SIDE, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
    const qs = {}
    for (const [k, text] of Object.entries(questions)) qs[k] = sdk.noul(text)
    const res = await api.systemOne({ state: { page: sdk.image(img) }, questions: qs })
    const out = {}
    for (const k of Object.keys(questions)) {
      const v = res.answers?.[k]?.noul
      out[k] = typeof v === 'number' ? v : null
    }
    return out
  } catch (e) {
    if ([401, 402, 403].includes(e?.status)) _lookPausedUntil = Date.now() + 10 * 60 * 1000
    _lookWhy = e?.status === 402 ? 'JEV has no TypeSafe credits left'
      : [401, 403].includes(e?.status) ? 'JEV refused the TypeSafe key' : 'JEV did not answer'
    console.warn('[jev] look failed:', e?.status || '', String(e?.message || e).slice(0, 120))
    return null
  }
}

/**
 * Show JEV pages of a document (a PDF's first and last page, or an image) and
 * ask typed questions about it. `questions` is { name: { choice: { label:
 * description, … } } | { noul: 'yes/no question' } }. Returns
 * { name: { choice, confidence } | { noul } } or null when JEV is off or did
 * not answer.
 */
export async function askAboutDocument(filePath, questions) {
  if (!jevReady() || Date.now() < _lookPausedUntil) return null
  const tmps = []
  try {
    const { sdk, api } = await client()
    const state = {}
    if (/\.pdf$/i.test(filePath)) {
      const mupdf = await import('mupdf')
      const doc = mupdf.Document.openDocument(fs.readFileSync(filePath), 'application/pdf')
      const n = doc.countPages()
      if (!n) return null
      const pages = n > 1 ? [['first_page', 0], ['last_page', n - 1]] : [['page', 0]]
      for (const [name, i] of pages) {
        const pix = doc.loadPage(i).toPixmap([1.5, 0, 0, 1.5, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
        const png = await sharp(Buffer.from(pix.asPNG())).resize({ width: JEV_MAX_SIDE, height: JEV_MAX_SIDE, fit: 'inside', withoutEnlargement: true }).png().toBuffer()
        state[name] = sdk.image(png)
      }
    } else {
      const page = await pageImage(filePath)
      if (page.tmp) tmps.push(page.tmp)
      state.page = sdk.image(page.buffer)
    }
    const qs = {}
    for (const [k, q] of Object.entries(questions)) {
      qs[k] = q.choice ? sdk.choice(q.text || 'Which of these is it?', q.choice) : sdk.noul(q.noul)
    }
    const res = await api.systemOne({ state, questions: qs })
    const out = {}
    for (const k of Object.keys(questions)) {
      const a = res.answers?.[k]
      out[k] = questions[k].choice
        ? { choice: a?.choice ?? null, confidence: Number(a?.confidence ?? 0) }
        : { noul: typeof a?.noul === 'number' ? a.noul : null }
    }
    return out
  } catch (e) {
    if ([401, 402, 403].includes(e?.status)) _lookPausedUntil = Date.now() + 10 * 60 * 1000
    console.warn('[jev] document question failed:', e?.status || '', String(e?.message || e).slice(0, 120))
    return null
  } finally {
    for (const t of tmps) try { fs.unlinkSync(t) } catch {}
  }
}

/** Delete the temporary page image of a classifyWithJev() result. */
export function release(result) {
  if (result?._tmp) try { fs.unlinkSync(result._tmp) } catch {}
}

/**
 * Crop the MRZ strip JEV located (with a margin, whole page width) and
 * upscale it for OCR. Returns a temp PNG path, or null.
 */
export async function cropMrz(result) {
  const b = result?.mrzBox
  if (!b || !(b.bottom > b.top)) return null
  try {
    const meta = await sharp(result._pageSrc).rotate().metadata()
    const W = meta.width, H = meta.height
    const padY = (b.bottom - b.top) * 0.6
    const top = Math.max(0, Math.floor((b.top - padY) * H))
    const bottom = Math.min(H, Math.ceil((b.bottom + padY) * H))
    if (bottom - top < 10) return null
    const out = path.join(os.tmpdir(), `adal-mrz-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
    await sharp(result._pageSrc).rotate()
      .extract({ left: 0, top, width: W, height: bottom - top })
      .resize({ width: 2000 }).grayscale().normalise().png().toFile(out)
    return out
  } catch { return null }
}

export default { jevReady, askAboutDocument, classifyWithJev, cropMrz, pickPrintedName, lookAtPage, lookUnavailableReason, release, JEV_DOC_TYPES }
