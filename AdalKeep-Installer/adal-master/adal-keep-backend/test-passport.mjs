import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { extractPassport, extractVisualFields } from './src/services/passportOcr.js'
import { parseTD3 } from './src/services/mrz.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const img = process.argv[2]
if (!img || !fs.existsSync(img)) {
  console.error('usage: node test-passport.mjs /path/to/passport.(jpg|png|pdf)')
  process.exit(1)
}

const ext = path.extname(img).toLowerCase()
let r
if (ext === '.pdf') {
  const mupdf = await import('mupdf')
  const data = fs.readFileSync(img)
  const doc = mupdf.Document.openDocument(data, 'application/pdf')
  const page = doc.loadPage(0)
  const pix = page.toPixmap([3,0,0,3,0,0], mupdf.ColorSpace.DeviceRGB, false, true)
  const tmp = path.join(__dirname, 'tmp-passport.png')
  fs.writeFileSync(tmp, Buffer.from(pix.asPNG()))
  r = await extractPassport(tmp, (p) => process.stdout.write(`\r[OCR ${p}%]`))
  fs.unlinkSync(tmp)
} else {
  r = await extractPassport(img, (p) => process.stdout.write(`\r[OCR ${p}%]`))
}
console.log('\n')

console.log('===================== VISUAL TEXT =====================')
console.log(r.visualText || '(empty)')
console.log('===================== MRZ TEXT ========================')
console.log(r.mrzText || '(empty)')

console.log('===================== RAW MRZ LINES ===================')
  for (const L of (r.mrzText || '').split(/\r?\n/)) {
    if (L && L.trim().length > 20) console.log('  raw:', JSON.stringify(L))
  }
  const { parseTD3: _p } = await import('./src/services/mrz.js')
  // DEBUG_RAW_MRZ — print normalized line 1 for inspection
  const rawLines = (r.mrzText || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean)
  const rawL1 = rawLines.find(x => /^[A-Z0-9<]{20,}$/.test(x) && x[0] === 'P')
  if (rawL1) {
    const pre = rawL1.slice(0, 5)
    let nm = rawL1.slice(5)
    nm = nm.replace(/([CKX])\1+/gi, m => '<'.repeat(m.length))
    nm = nm.replace(/<[CKX]/g, '<').replace(/[CKX]</g, '<')
    nm = nm.replace(/([A-Z]{3,})[CKX]([A-Z]{3,})/g, (f, a, b) => f.length >= 12 ? a + '<' + b : f)
    console.log('  normalized L1:', JSON.stringify(pre + nm))
  }

  const mrz = parseTD3(r.mrzText)
const vis = extractVisualFields(r.visualText)

console.log('===================== MRZ PARSED ======================')
console.log(JSON.stringify(mrz, null, 2))
console.log('===================== VIS EXTRACTED ===================')
console.log(JSON.stringify(vis, null, 2))

// Merge preview (mirrors mergePassportFields in docPipeline.js)
function mergePassportFields(m, v) {
  const ex = {}
  if (m?.passport_number) ex.passport_number = m.passport_number
  let surname = m?.surname || v?.surname || null
  let given = m?.given_names || v?.given_names || null
  if (given && surname && given.toUpperCase().endsWith(surname.toUpperCase())) {
    const trimmed = given.slice(0, given.length - surname.length).trim()
    if (trimmed.length >= 2) given = trimmed
  }
  if (given) { ex.first_name = given.split(/\s+/)[0]; ex.given_names = given }
  if (surname) ex.last_name = surname
  const parts = [given, surname].filter(Boolean)
  if (parts.length) ex.full_name = parts.join(' ')
  if (m?.date_of_birth) ex.date_of_birth = m.date_of_birth
  else if (v?.date_of_birth) ex.date_of_birth = v.date_of_birth
  if (m?.date_of_expiry) ex.passport_expiry_date = m.date_of_expiry
  else if (v?.date_of_expiry) ex.passport_expiry_date = v.date_of_expiry
  if (v?.date_of_issue) ex.passport_issue_date = v.date_of_issue
  else if (v?.dates_in_order?.length) {
    const dob = m?.date_of_birth || v.date_of_birth
    const exp = m?.date_of_expiry || v.date_of_expiry
    const u = v.dates_in_order.find(d => d.iso && d.iso !== dob && d.iso !== exp)
    if (u) ex.passport_issue_date = u.iso
  }
  if (v?.place_of_birth) ex.place_of_birth = v.place_of_birth
  if (m?.sex) ex.gender = m.sex
  if (m?.nationality_code) ex.nationality = m.nationality_code === 'ETH' ? 'Ethiopian' : m.nationality_code
  return ex
}

console.log('===================== FINAL MERGED ====================')
console.log(JSON.stringify(mergePassportFields(mrz, vis), null, 2))
