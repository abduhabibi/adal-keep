/**
 * docDetails.js — every detail on a CV, visa or contract that arrives in
 * Downloads (asked on 2026-11-14: "extract every data you find, use JEV").
 *
 * JEV never writes text, so it does what it is good at:
 *   - box:    it points to where each value is printed (only the value, not
 *             its label); this PC reads that spot (Tesseract), and
 *   - choice: it answers the questions whose answer is one of a few
 *             (religion, marital status, sex, experience, languages …).
 * The page's own text (a PDF with text inside, or the whole page read here)
 * fills what JEV could not point to ("Label: value").
 *
 * Returns { column: value } for profile columns; the pipeline only writes the
 * ones the profile does not have yet.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import sharp from 'sharp'
import { fileURLToPath } from 'url'
import { parseAnyDate } from './passportOcr.js'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

// What is read from each kind of document: column → [kind, where it is (for JEV), labels on the page]
// A visa or contract names the sponsor / employer too: the worker's name is
// taken from a CV only (checked 2026-11-14: on visas and contracts it was never hers).
const COMMON = {
  passport_number: ['passport', 'The worker\'s passport number', ['passport no', 'passport number', 'passport #', 'passport']],
}
const PERSON = {
  full_name: ['name', 'The worker\'s full name (the candidate / applicant / employee, not the employer or agency)', ['full name', 'name of applicant', 'applicant name', 'candidate name', 'employee name', 'worker name', 'name']],
  date_of_birth: ['date', 'The date of birth', ['date of birth', 'birth date', 'd.o.b', 'dob']],
  place_of_birth: ['text', 'The place of birth', ['place of birth', 'birth place', 'pob']],
  nationality: ['word', 'The nationality', ['nationality']],
}
const FIELDS = {
  CV: {
    ...COMMON,
    ...PERSON,
    passport_issue_date: ['date', 'The passport date of issue', ['date of issue', 'issue date', 'issued date', 'passport issue date']],
    passport_expiry_date: ['date', 'The passport date of expiry', ['date of expiry', 'expiry date', 'expiration date', 'passport expiry date', 'valid until']],
    phone_number: ['phone', 'The worker\'s own phone / mobile number', ['mobile', 'phone', 'tel', 'contact number', 'telephone']],
    children_count: ['int', 'The number of children', ['number of children', 'no of children', 'children']],
    height: ['int', 'The height (cm)', ['height']],
    weight: ['int', 'The weight (kg)', ['weight']],
    education_level: ['text', 'The education level / qualification', ['education', 'educational level', 'qualification', 'education level']],
    living_town: ['text', 'The home town, city or address of the worker', ['address', 'city', 'living town', 'home town', 'residence']],
    job_title: ['text', 'The position / job applied for', ['position applied for', 'position', 'post applied', 'job title', 'applied for']],
    salary: ['int', 'The monthly salary asked', ['monthly salary', 'salary']],
    experience_years: ['int', 'The years of work experience abroad', ['years of experience', 'experience years', 'period', 'duration']],
    emergency_name: ['name', 'The name of the emergency contact / relative / next of kin', ['emergency contact', 'next of kin', 'relative name', 'contact person']],
    emergency_phone: ['phone', 'The phone number of the emergency contact / relative', ['emergency phone', 'relative phone', 'kin phone']],
    mother_name: ['name', 'The mother\'s name', ['mother name', 'mother\'s name', 'mother']],
    father_name: ['name', 'The father\'s name', ['father name', 'father\'s name', 'father']],
    spouse_name: ['name', 'The husband\'s / spouse\'s name', ['spouse name', 'husband name', 'spouse']],
    labor_id: ['digits', 'The labour ID number', ['labour id', 'labor id', 'lmis id']],
  },
  Visa: {
    ...COMMON,
    visa_number: ['digits', 'The visa number', ['visa no', 'visa number', 'visa #', 'رقم التأشيرة']],
    visa_application_number: ['digits', 'The application number', ['application no', 'application number', 'enjaz no', 'e-number']],
    employer_name: ['text', 'The sponsor / employer name', ['sponsor name', 'employer name', 'name of sponsor', 'sponsor', 'employer']],
    employer_id: ['digits', 'The sponsor / employer ID number', ['sponsor id', 'employer id', 'sponsor no', 'id no']],
    employer_phone: ['phone', 'The sponsor / employer phone number', ['sponsor phone', 'employer phone', 'mobile']],
    work_city: ['text', 'The city of the sponsor / work', ['city', 'work city', 'place of work']],
    job_title: ['text', 'The profession / occupation on the visa', ['profession', 'occupation', 'job title']],
    destination_country: ['word', 'The country that issued the visa', ['country']],
  },
  Contract: {
    ...COMMON,
    contract_number: ['digits', 'The contract number', ['contract no', 'contract number', 'contract #']],
    contract_date: ['date', 'The contract date', ['contract date', 'date of contract', 'dated']],
    visa_number: ['digits', 'The visa number', ['visa no', 'visa number']],
    employer_name: ['text', 'The employer\'s name (first party)', ['employer name', 'name of employer', 'first party', 'employer']],
    employer_id: ['digits', 'The employer\'s ID number', ['employer id', 'id number', 'id no', 'national id']],
    employer_phone: ['phone', 'The employer\'s phone number', ['employer phone', 'employer mobile', 'mobile', 'phone']],
    employer_address: ['text', 'The employer\'s address', ['employer address', 'address']],
    work_city: ['text', 'The city of work', ['city', 'work city']],
    salary: ['int', 'The monthly salary', ['monthly salary', 'salary', 'wage']],
    job_title: ['text', 'The job / profession of the worker', ['profession', 'occupation', 'job title', 'position']],
  },
}
// Answers that are one of a few: JEV picks.
const CHOICES = {
  religion: ['What is the worker\'s religion on this document?', { Muslim: 'Muslim / Islam', Orthodox: 'Orthodox Christian', Protestant: 'Protestant / Christian', none: 'Not written' }],
  marital_status: ['What is the worker\'s marital status on this document?', { SINGLE: 'Single / unmarried', MARRIED: 'Married', DIVORCED: 'Divorced', WIDOWED: 'Widowed', none: 'Not written' }],
  gender: ['What is the worker\'s sex on this document?', { F: 'Female', M: 'Male', none: 'Not written' }],
  work_experience: ['Does the document say the worker has worked abroad before?', { 'Have experience': 'Yes, previous work abroad / experience is listed', 'No experience': 'No, new / first time / no experience', none: 'Not written' }],
  experience_country: ['In which country did the worker work before?', { 'Saudi Arabia': 'Saudi Arabia / KSA', Kuwait: 'Kuwait', 'United Arab Emirates': 'UAE / Dubai / Abu Dhabi', Qatar: 'Qatar', Jordan: 'Jordan', Oman: 'Oman', Bahrain: 'Bahrain', none: 'Not written / no experience / another country' }],
  speaks_arabic: ['Does the worker speak Arabic (according to the document)?', { yes: 'Yes (fair, good, fluent, little)', no: 'No / poor / none', none: 'Not written' }],
  speaks_english: ['Does the worker speak English (according to the document)?', { yes: 'Yes (fair, good, fluent, little)', no: 'No / poor / none', none: 'Not written' }],
  cooking_skill: ['Can the worker cook (according to the document)?', { Cooking: 'Yes, cooking', 'Cooking Helper': 'A little / helper', None: 'No', none: 'Not written' }],
}
const CHOICES_FOR = { CV: Object.keys(CHOICES), Visa: ['gender'], Contract: ['gender', 'religion'] }

export const DETAIL_TYPES = new Set(Object.keys(FIELDS))

// ------------------------------------------------------------ values --
function clean(kind, raw) {
  let s = String(raw || '').replace(/[|_[\]{}<>]/g, ' ').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[:;\-–.,\s]+|[:;\-–,\s]+$/g, '')
  if (!s) return null
  switch (kind) {
    case 'date': {
      const iso = s.match(/\b(19|20)\d{2}[-/.](0?[1-9]|1[0-2])[-/.](0?[1-9]|[12]\d|3[01])\b/)
      if (iso) { const [y, m, d] = iso[0].split(/[-/.]/); return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}` }
      const d = parseAnyDate(s)
      return d && /^(19|20)\d{2}-\d{2}-\d{2}$/.test(d) ? d : null
    }
    case 'passport': { const m = s.toUpperCase().replace(/\s/g, '').match(/[A-Z]{1,2}\d{6,9}/); return m ? m[0] : null }
    case 'phone': {
      const d = s.replace(/[^\d+]/g, '')
      return d.replace(/\D/g, '').length >= 9 && d.replace(/\D/g, '').length <= 13 ? d : null
    }
    case 'int': { const m = s.match(/\d+(\.\d+)?/); return m ? String(Math.round(Number(m[0]))) : null }
    // A number on its own (visa, application, contract, ID): 6–15 digits, an
    // "E" before an Enjaz application number; never a date or a word.
    case 'digits': {
      if (/\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}/.test(s)) return null
      const m = s.toUpperCase().replace(/(\d)\s+(?=\d)/g, '$1').match(/\b(E?)(\d{6,15})\b/)
      return m ? m[1] + m[2] : null
    }
    case 'name': {
      const n = s.replace(/[^A-Za-zሀ-፿\s.'-]/g, ' ').replace(/\s+/g, ' ').trim()
      return n.split(' ').filter(w => w.length > 1).length >= 1 && n.length >= 3 ? n.toUpperCase() : null
    }
    case 'word': { const w = s.replace(/[^A-Za-z\s]/g, ' ').trim().split(/\s+/)[0]; return w && w.length > 2 ? w.toUpperCase() : null }
    default: return s.length >= 2 && s.length <= 120 ? s : null
  }
}

// "Label: value" in the page's own text.
function fromText(text, labels, kind) {
  const lines = String(text || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  for (const label of labels) {
    // At the start of a line or a table cell ("| Name:"), so "Father name" is not "Name".
    const re = new RegExp(`(?:^|\\|\\s*|\\t|\\s{2,})${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*')}\\s*[:：\\-–.]?\\s*(.*)$`, 'i')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(re)
      if (!m) continue
      const v = clean(kind, m[1]) || clean(kind, lines[i + 1] || '')
      if (v) return v
    }
  }
  return null
}

// ------------------------------------------------------------- pages --
async function pages(filePath, max = 2) {
  if (!/\.pdf$/i.test(filePath)) return { images: [await sharp(filePath).rotate().png().toBuffer()], text: '' }
  const mupdf = await import('mupdf')
  const doc = mupdf.Document.openDocument(fs.readFileSync(filePath), 'application/pdf')
  const images = []
  let text = ''
  for (let i = 0; i < Math.min(max, doc.countPages()); i++) {
    const page = doc.loadPage(i)
    try { text += page.toStructuredText('preserve-whitespace').asText() + '\n' } catch {}
    images.push(Buffer.from(page.toPixmap([2.5, 0, 0, 2.5, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true).asPNG()))
  }
  return { images, text }
}

let _worker = null
async function ocr() {
  if (_worker) return _worker
  const { createWorker } = await import('tesseract.js')
  _worker = await createWorker(['eng'], 1, { langPath: ROOT, cachePath: path.join(ROOT, 'data', 'tessdata'), gzip: false })
  return _worker
}
async function readSpot(png, meta, b, singleLine) {
  const padX = (b.right - b.left) * 0.06 + 0.004, padY = (b.bottom - b.top) * 0.25 + 0.003
  const L = Math.max(0, Math.floor((b.left - padX) * meta.width)), R = Math.min(meta.width, Math.ceil((b.right + padX) * meta.width))
  const T = Math.max(0, Math.floor((b.top - padY) * meta.height)), B = Math.min(meta.height, Math.ceil((b.bottom + padY) * meta.height))
  if (R - L < 8 || B - T < 6) return ''
  const crop = await sharp(png).extract({ left: L, top: T, width: R - L, height: B - T })
    .resize({ height: Math.max(60, Math.min(220, (B - T) * 2)), withoutEnlargement: false }).grayscale().normalise().png().toBuffer()
  const w = await ocr()
  await w.setParameters({ tessedit_pageseg_mode: singleLine ? '7' : '6' })
  return (await w.recognize(crop)).data.text
}

/**
 * Every detail of a CV / Visa / Contract: { column: value }.
 * `log` gets one line about how it went (no personal data).
 */
export async function readDocumentDetails(filePath, docType, log = () => {}) {
  const fields = FIELDS[docType]
  if (!fields) return {}
  const t0 = Date.now()
  const out = {}
  const { images, text: layer } = await pages(filePath)
  const jev = await import('./jevClassifier.js')
  let pointed = 0, chosen = 0
  // 1. JEV points to each value on the first page (and the second, for what is still missing); this PC reads it.
  for (const png of images) {
    const want = Object.entries(fields).filter(([col]) => !out[col])
    if (!want.length) break
    const boxes = Object.fromEntries(want.map(([col, [, where]]) => [col, `${where}: only the written value, not its label. Nothing if it is not on this page.`]))
    const found = await jev.findOnPage(png, boxes).catch(() => null)
    if (!found) break   // JEV off / out of credits: the page text below does it
    const meta = await sharp(png).metadata()
    for (const [col, [kind]] of want) {
      const b = found[col]
      if (!b || !(b.confidence >= 0.3) || !(b.right > b.left && b.bottom > b.top)) continue
      const v = clean(kind, await readSpot(png, meta, b, kind !== 'text').catch(() => ''))
      if (v) { out[col] = v; pointed++ }
    }
  }
  // 2. Answers that are one of a few: JEV picks them from the first page.
  const ask = (CHOICES_FOR[docType] || []).filter(k => !out[k])
  if (ask.length) {
    const picked = await jev.chooseOnPage(images[0], Object.fromEntries(ask.map(k => [k, CHOICES[k]]))).catch(() => null)
    for (const k of ask) {
      const a = picked?.[k]
      if (a && a.choice && a.choice !== 'none' && a.confidence >= 0.6) { out[k] = a.choice; chosen++ }
    }
  }
  // 3. What is still missing: the page's own words ("Label: value").
  const missing = Object.entries(fields).filter(([col]) => !out[col])
  let fromPage = 0
  if (missing.length) {
    let text = layer
    if (String(text).replace(/\s/g, '').length < 80) {
      text = ''
      const w = await ocr().catch(() => null)
      if (w) {
        await w.setParameters({ tessedit_pageseg_mode: '4' })
        for (const png of images) text += (await w.recognize(await sharp(png).grayscale().normalise().png().toBuffer())).data.text + '\n'
      }
    }
    for (const [col, [kind, , labels]] of missing) {
      const v = fromText(text, labels, kind)
      if (v) { out[col] = v; fromPage++ }
    }
    if (!out.religion && /\b(muslim|islam)\b/i.test(text)) out.religion = 'Muslim'
    if (!out.marital_status) { const m = String(text).match(/\b(single|married|divorced|widow(?:ed)?)\b/i); if (m) out.marital_status = m[1].toUpperCase().replace(/^WIDOW$/, 'WIDOWED') }
  }
  // Tidy: a phone from an Ethiopian number, the name split.
  for (const k of ['phone_number', 'emergency_phone']) {
    if (!out[k]) continue
    const d = out[k].replace(/\D/g, '')
    if (d.length === 9 && /^[79]/.test(d)) out[k] = '0' + d
    else if (d.length === 12 && d.startsWith('251')) out[k] = '+' + d
  }
  if (out.full_name) {
    const parts = out.full_name.split(' ')
    if (parts.length >= 2) { out.given_names = parts.slice(0, -1).join(' '); out.surname = parts[parts.length - 1] }
  }
  log(`details of the ${docType}: ${Object.keys(out).length} read (JEV pointed ${pointed}, JEV chose ${chosen}, page text ${fromPage}) in ${Date.now() - t0} ms`)
  return out
}

// Tesseract stays loaded between documents; let it go when Adal Keep closes.
process.once('exit', () => { try { _worker?.terminate() } catch {} })
export const _test = { clean, fromText }
