/**
 * mineruClassifier.js
 *
 * Classifies a document from the Markdown MinerU produced for it. No LLM call:
 *   - Passports: the MRZ (two machine-readable lines at the bottom of the data
 *     page) is parsed with ICAO check digits. Only a fully verified MRZ is
 *     accepted, so name / passport number / dates come from checksummed data.
 *   - Everything else: keyword rules taken from the agency's document list.
 *
 * Returns the same shape the pipeline already expects:
 *   { doc_type, confidence, fields }   doc_type 'other' = ignore the file.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseTD3, fitLine2 } from './mrz.js'
import { parseDocumentToMarkdown } from './mineruClient.js'
import { classifyWithGemini } from './geminiClassifier.js'
import { jevReady, classifyWithJev, cropMrz, pickPrintedName, release } from './jevClassifier.js'

// Each rule: doc_type plus patterns. A rule scores by the number of patterns
// that match; the highest score wins, ties go to the earlier rule.
const RULES = [
  { doc_type: 'Police Clearance', patterns: [/certificate of good conduct/i, /police clearance/i, /police certificate/i] },
  { doc_type: 'COC', patterns: [/certificate of competence/i, /\bCOC\b/] },
  { doc_type: 'Medical Report', patterns: [/medical report/i, /fit for work/i, /blood group/i, /chest x-?ray/i] },
  { doc_type: 'Visa', patterns: [/\bentry visa\b/i, /\bvisa (no|number)\b/i, /\bvisa\b/i] },
  { doc_type: 'Saudi-letter', patterns: [/saudi (embassy|consulate)/i, /kingdom of saudi arabia/i] },
  { doc_type: 'Musaned', patterns: [/musaned/i] },
  { doc_type: 'Broker ID', patterns: [/broker/i] },
  { doc_type: 'Labour ID', patterns: [/labou?r (id|card)/i] },
  { doc_type: 'Employee ID', patterns: [/employee (id|card)/i] },
  { doc_type: 'Client ID', patterns: [/client (id|card)/i] },
  { doc_type: 'Slip', patterns: [/order id/i, /debit account/i, /credit account/i, /\bswift\b/i] },
  { doc_type: 'Experience Form', patterns: [/experience (form|letter)/i] },
  { doc_type: 'Insurance', patterns: [/insurance/i, /policy (no|number)/i] },
  { doc_type: 'CV', patterns: [/curriculum vitae/i, /\bresume\b/i, /\bCV\b/] },
  { doc_type: 'Contract', patterns: [/employment contract/i, /employer name/i, /\bcontract\b/i] },
  { doc_type: 'Government ID', patterns: [/kebele/i, /national id/i, /identity card/i] },
]

// Ticket types need the deported / ongoing split, so they are handled apart.
const TICKET_PATTERNS = [/e-?ticket/i, /airline/i, /boarding pass/i, /\bflight\b/i]

// Two MRZ lines: TD3 passports are 44 characters per line. Matched loosely
// because MinerU often drops or adds a character at line ends.
const MRZ_LINE1 = /P[<A-Z][A-Z]{3}[A-Z<]{30,40}/
const MRZ_LINE2 = /[A-Z0-9<]{9}[0-9<][A-Z<]{3}[0-9]{6}[0-9<][MFX<][0-9]{6}[0-9<][A-Z0-9<]{14}[0-9<]{2}/

export function findMrz(markdown) {
  const lines = String(markdown)
    .split(/\r?\n/)
    .map(l => l.replace(/\s+/g, '').toUpperCase())
    .filter(l => l.length >= 30)
  for (let i = 0; i < lines.length - 1; i++) {
    const l1 = lines[i].match(MRZ_LINE1)
    const l2 = fitLine2(lines[i + 1]).match(MRZ_LINE2)
    if (l1 && l2) return { line1: l1[0].padEnd(44, '<').slice(0, 44), line2: l2[0] }
  }

  // MinerU often returns both MRZ lines run together on one line. Fall back to
  // scanning the whitespace-free text: a TD3 line 1 is followed by line 2.
  const flat = String(markdown).replace(/\s+/g, '').toUpperCase()
  const re = /(?=(P[<A-Z][A-Z]{3}[A-Z<]{30,40}))/g
  let m
  while ((m = re.exec(flat))) {
    const line1 = flat.slice(m.index, m.index + 44)
    const line2 = flat.slice(m.index + 44, m.index + 88)
    if (line1.length === 44 && MRZ_LINE2.test(line2)) return { line1, line2 }
    re.lastIndex = m.index + 1 // zero-width match: step forward by hand
  }
  return null
}

function passportFromMrz(markdown) {
  const mrz = findMrz(markdown)
  if (!mrz) return null
  const p = parseTD3(`${mrz.line1}\n${mrz.line2}`)
  if (!p || !p.overall_verified) return { verified: false, fields: null }

  const fields = {
    surname: p.surname,
    given_names: p.given_names,
    full_name: `${p.given_names} ${p.surname}`.trim(),
    passport_number: p.passport_number,
    date_of_birth: p.date_of_birth,
    date_of_expiry: p.date_of_expiry,
    sex: p.sex,
    gender: p.sex,
    nationality: p.nationality_code,
  }
  return { verified: true, fields }
}

function ticketType(markdown) {
  if (!TICKET_PATTERNS.some(re => re.test(markdown))) return null
  return /deport/i.test(markdown) ? 'Ticket-deported' : 'Ticket-ongoing'
}

/**
 * @param {string} markdown  full text MinerU produced for the document
 * @returns {{doc_type:string, confidence:number, fields:object}}
 */
export function classifyMarkdown(markdown) {
  const text = String(markdown || '')

  // 1. Passport — MRZ is authoritative. An unverified MRZ is not trusted.
  const pass = passportFromMrz(text)
  if (pass?.verified) {
    return { doc_type: 'Passport', confidence: 0.98, fields: pass.fields }
  }

  // 1b. Passport page without a verified MRZ — accepted at lower confidence,
  // with no MRZ-derived fields (the name then comes from the filename).
  // Needs the document title line "PASSPORT" plus its own fields, so visas and
  // letters that merely mention a passport number do not match.
  if (/^\s*passport\s*$/im.test(text) && /passport (no|number)/i.test(text) && /(surname|date of birth)/i.test(text)) {
    return { doc_type: 'Passport', confidence: 0.6, fields: {} }
  }

  // 2. Keyword rules.
  let best = null
  let bestScore = 0
  for (const rule of RULES) {
    const score = rule.patterns.reduce((n, re) => n + (re.test(text) ? 1 : 0), 0)
    if (score > bestScore) { best = rule.doc_type; bestScore = score }
  }

  const ticket = ticketType(text)
  if (ticket && bestScore < 2) { best = ticket; bestScore = 1 }

  if (!best || bestScore === 0) {
    // Blurry passport pages often lose the "PASSPORT" title but keep the field
    // labels. Three or more passport cues, and no other rule matched, means a
    // passport at low confidence; the MRZ gate still decides if it is usable.
    const cues = [/\bPP\b/, /\bETH\b/, /expi?r?y/i, /personal no/i, /nationality/i, /date of birth/i, /surname|given name/i]
    if (cues.filter(re => re.test(text)).length >= 3) {
      return { doc_type: 'Passport', confidence: 0.5, fields: {} }
    }
    return { doc_type: 'other', confidence: 0, fields: {} }
  }
  return { doc_type: best, confidence: Math.min(0.95, 0.5 + 0.15 * bestScore), fields: {} }
}

/**
 * Ingestion analyzer: MinerU reads the ORIGINAL file (PDFs included), then the
 * text is classified. A MinerU failure throws so the queue retries the file;
 * there is no silent fallback to another paid model.
 */
// ---------------------------------------------------------------------------
// Fast path: local reading first, MinerU only when local reading is not enough
// ---------------------------------------------------------------------------

// OCR often confuses these letters with digits. Only numeric MRZ positions use it.
const DIGIT_FIX = { O: '0', D: '0', Q: '0', I: '1', L: '1', B: '8', S: '5', Z: '2', G: '6', T: '7' }
// TD3 line 2 numeric positions: doc-number check (9), DOB (13-18) + check (19),
// expiry (21-26) + check (27), personal-number check (42), composite check (43).
const LINE2_NUMERIC = [9, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26, 27, 42, 43]

/** Repair the digit positions of an OCR'd MRZ line 2, then let parseTD3 check it. */
function repairLine2(line2) {
  const chars = line2.split('')
  for (const i of LINE2_NUMERIC) if (chars[i] && DIGIT_FIX[chars[i]]) chars[i] = DIGIT_FIX[chars[i]]
  return chars.join('')
}

/**
 * Passport from local OCR (Tesseract). Accepted only when the MRZ check digits
 * verify after repair, and line 1 has no OCR garbage run that would corrupt names.
 */
/** Levenshtein distance, used to allow one OCR slip in a name word. */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
  }
  return d[a.length][b.length]
}

/**
 * Every name word from the MRZ must also appear in the visible printed text.
 * The MRZ names have no checksum, so this is the check that protects them.
 * Words of 4+ letters may differ by one letter (OCR slip); shorter must match.
 */
function nameConfirmedByVisualText(names, visualText) {
  const words = String(visualText || '').toUpperCase().split(/[^A-Z]+/).filter(Boolean)
  if (!words.length) return false
  return names.split(/\s+/).filter(Boolean).every(tok => {
    if (tok.length < 3) return true
    // "<" is often read as a leading letter in the MRZ ("SHABISSO" for "HABISSO").
    const variants = tok.length >= 6 ? [tok, tok.slice(1)] : [tok]
    return variants.some(v => words.some(w => (v.length >= 4 ? editDistance(v, w) <= 1 : v === w)))
  })
}

async function passportFromLocalOcr(r) {
  const lines = String(r?.mrzText || '').split(/\r?\n/).map(l => l.replace(/\s+/g, '').toUpperCase())
  let l1 = lines.find(l => /^P[<A-Z]/.test(l) && l.length >= 40)
  const l2 = lines.find(l => l !== l1 && l.length >= 40 && /[0-9]{6}/.test(l))
  if (!l1 || !l2) return null
  l1 = l1.replace(/(.)\1{2,}.*$/, '') // OCR tail junk ("CCCCCLL") after the name
  const line1 = l1.padEnd(44, '<').slice(0, 44)
  const line2 = repairLine2(fitLine2(l2))
  const mrz = parseTD3(`${line1}\n${line2}`)
  if (!mrz || !mrz.overall_verified) return null
  if (!nameConfirmedByVisualText(`${mrz.given_names} ${mrz.surname}`, r?.visualText)) return null
  return {
    doc_type: 'Passport',
    confidence: 0.98,
    fields: {
      surname: mrz.surname,
      given_names: mrz.given_names,
      full_name: `${mrz.given_names} ${mrz.surname}`.trim(),
      passport_number: mrz.passport_number,
      date_of_birth: mrz.date_of_birth,
      date_of_expiry: mrz.date_of_expiry,
      sex: mrz.sex,
      gender: mrz.sex,
      nationality: mrz.nationality_code,
    },
    markdown: `${line1}\n${line2}`, // repaired MRZ, so the verification step can re-read it
    source: 'local-ocr',
  }
}

/** Lower 55% of the image, upscaled, written to a temp file (deleted by the caller). */
async function lowerPageCrop(imagePath) {
  try {
    const sharp = (await import('sharp')).default
    const meta = await sharp(imagePath).metadata()
    const out = path.join(os.tmpdir(), `adal-crop-${Date.now()}-${Math.random().toString(36).slice(2)}.png`)
    await sharp(imagePath).rotate()
      .extract({ left: 0, top: Math.round(meta.height * 0.45), width: meta.width, height: Math.round(meta.height * 0.55) })
      .resize({ width: 1600 }).png().toFile(out)
    return out
  } catch { return null }
}

/**
 * Returns a result without calling MinerU, or null when MinerU is needed.
 *  - PDF with a text layer: read directly (milliseconds).
 *  - Image: local OCR; only a checksum-verified passport is accepted here.
 */
export async function analyzeLocally(originalPath) {
  if (/\.pdf$/i.test(originalPath)) {
    try {
      const mod = await import('pdf-parse')
      const parse = mod.default || mod.pdf || mod
      const res = await parse(fs.readFileSync(originalPath))
      const text = String(res?.text || '')
      if (text.replace(/\s/g, '').length >= 60) return { text }
    } catch { /* no text layer: fall through */ }
    return null
  }
  if (IMAGE_EXT.test(originalPath)) {
    try {
      const { extractPassport } = await import('./passportOcr.js')
      const ocr = await extractPassport(originalPath)
      // Second pass on the lower part of the page, upscaled: the printed names
      // are small there, and the crop reads them much better.
      const crop = await lowerPageCrop(originalPath)
      if (crop) {
        try {
          const more = await extractPassport(crop)
          ocr.visualText = `${ocr.visualText || ''}\n${more?.visualText || ''}`
        } finally { try { fs.unlinkSync(crop) } catch {} }
      }
      const pass = await passportFromLocalOcr(ocr)
      if (pass) return pass
      const visual = String(ocr?.visualText || '')
      // Almost no printed words and no MRZ: a personal photo, decided locally.
      if (wordCount(visual) < 5 && !/[0-9]{6}/.test(String(ocr?.mrzText || ''))) {
        return { doc_type: 'Photo', confidence: 0.6, fields: {}, markdown: '', source: 'local-ocr' }
      }
    } catch { /* OCR failure: MinerU decides */ }
  }
  return null
}

// ---------------------------------------------------------------------------
// JEV first: typed answers the system acts on directly (see jevClassifier.js)
// ---------------------------------------------------------------------------
const JEV_MIN = Number(process.env.JEV_MIN_CONFIDENCE || 0.8)
const JEV_PERSON_MIN = Number(process.env.JEV_PROFILE_MIN_CONFIDENCE || 0.85)
// These documents carry text the system needs (order ID, dates): Gemini still reads them.
const NEEDS_TEXT = new Set(['Slip', 'Contract', 'Police Clearance'])
let jevPausedUntil = 0

/**
 * Line 2 of the MRZ from OCR texts of the strip: the first reading whose check
 * digits verify (after fixing letters in digit positions). Returns
 * { line2, mrz, line1raw } or null.
 */
export function verifiedLine2(texts) {
  for (const text of texts) {
    const lines = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, '').toUpperCase()).filter(l => l.length >= 36)
    const l2 = lines.find(l => /^[A-Z0-9<]{9}[0-9<]/.test(l) && /[0-9]{6}/.test(l.slice(13)))
    if (!l2) continue
    const line2 = repairLine2(fitLine2(l2))
    const mrz = parseTD3(`P<XXX${'<'.repeat(39)}\n${line2}`)
    if (mrz?.overall_verified) return { line2, mrz, line1raw: lines.find(l => l !== l2 && /^P/.test(l)) || '' }
  }
  return null
}

/**
 * Possible names in an OCR'd MRZ line 1, where "<" separators may have been
 * read as S, C, K or L. Returns up to 8 "GIVEN NAMES SURNAME" readings.
 */
export function nameCandidates(line1raw) {
  let n = String(line1raw || '').toUpperCase().slice(5).replace(/[0-9]/g, d => ({ 0: 'O', 1: 'I', 5: 'S', 8: 'B' })[d] || '')
  n = n.replace(/[<CLK]{3,}.*$/, '').replace(/<+$/, '') // filler at the end
  const out = new Set()
  const words = (g) => g.split('<').filter(Boolean)
  for (let i = 1; i < n.length - 1; i++) {
    if (!/[<SCK]{2}/.test(n.slice(i, i + 2))) continue
    const surname = n.slice(0, i).replace(/</g, ' ').trim()
    const given = n.slice(i + 2)
    if (surname.length < 2 || given.length < 2) continue
    out.add(`${words(given).join(' ')} ${surname}`)
    // one more misread single separator inside the given names
    for (let j = 3; j < given.length - 3; j++) {
      if (!/[<SCK]/.test(given[j])) continue
      out.add(`${words(given.slice(0, j)).join(' ')} ${words(given.slice(j + 1)).join(' ')} ${surname}`)
    }
  }
  return [...out].map(x => x.replace(/\s+/g, ' ').trim()).slice(0, 8)
}

/**
 * Returns { result } when JEV settled the document, { hint } when the usual
 * path must decide (JEV unsure, or the text itself is needed), or null when
 * JEV is not available.
 */
async function analyzeWithJev(originalPath, db) {
  if (!jevReady() || Date.now() < jevPausedUntil) return null
  let r
  try {
    const profiles = db
      ? await db('profiles').select('id', 'full_name', 'passport_number', 'labor_id').orderBy('updated_at', 'desc').limit(150)
      : []
    r = await classifyWithJev(originalPath, { profiles })
  } catch (e) {
    // No credits / bad key: stop asking for a while instead of failing every file.
    if ([401, 402, 403].includes(e.status)) jevPausedUntil = Date.now() + 10 * 60 * 1000
    console.warn(`[classify] JEV unavailable (${e.status || ''} ${e.message.slice(0, 80)}) — using the usual path`)
    return null
  }
  try {
    console.log(`[classify] JEV ${r.ms}ms: ${r.doc_type} ${r.confidence.toFixed(2)} readable=${r.readable?.toFixed(2)} person=${r.person ? `#${r.person.id} ${r.person.confidence.toFixed(2)}` : '-'}`)
    if (r.confidence < JEV_MIN) return { hint: r }

    const person = db && r.person && r.person.confidence >= JEV_PERSON_MIN
      ? await db('profiles').where('id', r.person.id).first()
      : null

    if (r.doc_type === 'Passport') {
      // The text comes from the page itself: crop the MRZ JEV located, read it
      // locally, and let the check digits prove it.
      const crop = await cropMrz(r)
      if (crop) {
        try {
          const { readMrzStrip } = await import('./passportOcr.js')
          const got = verifiedLine2(await readMrzStrip(crop))
          if (got) {
            // Number + dates are proven by the check digits. The name: from the
            // matched profile when its passport number is the same, else JEV
            // picks the printed one among the possible readings.
            const m = got.mrz
            let name = null
            if (person && String(person.passport_number || '').toUpperCase() === m.passport_number) {
              name = person.full_name
            } else {
              const pick = await pickPrintedName(r, nameCandidates(got.line1raw)).catch(() => null)
              if (pick && pick.confidence >= JEV_MIN) name = pick.name
            }
            if (name) {
              const parts = name.split(' ')
              const fields = {
                full_name: name,
                surname: parts.length > 1 ? parts[parts.length - 1] : '',
                given_names: parts.slice(0, -1).join(' '),
                passport_number: m.passport_number,
                date_of_birth: m.date_of_birth,
                date_of_expiry: m.date_of_expiry,
                sex: m.sex, gender: m.sex,
                nationality: m.nationality_code,
              }
              return { result: { doc_type: 'Passport', confidence: 0.98, fields, markdown: got.line2, source: 'jev+mrz' } }
            }
            console.log('[classify] JEV: MRZ number verified, name not settled — usual path reads the passport')
          }
        } finally { try { fs.unlinkSync(crop) } catch {} }
      }
      return { hint: r, person }
    }

    if (NEEDS_TEXT.has(r.doc_type)) return { hint: r, person }

    // Settled: the type is one of our field names, the person is a profile id.
    const fields = person ? { full_name: person.full_name, ...(person.passport_number ? { passport_number: person.passport_number } : {}) } : {}
    return { result: { doc_type: r.doc_type, confidence: r.confidence, fields, markdown: '', source: 'jev' } }
  } finally {
    release(r)
  }
}

export async function analyzeWithMineru(originalPath, { db = null } = {}) {
  const filename = path.basename(originalPath)

  const jev = await analyzeWithJev(originalPath, db)
  if (jev?.result) return jev.result
  const decided = await analyzeUsual(originalPath, filename)
  // JEV was sure of the type (or the person) but the text had to be read:
  // keep JEV's type and person, take the text fields from the usual path.
  if (jev?.hint && jev.hint.confidence >= JEV_MIN && decided.doc_type !== 'Passport') {
    decided.doc_type = jev.hint.doc_type
    decided.confidence = Math.max(decided.confidence || 0, jev.hint.confidence)
    decided.source = `jev+${decided.source || 'usual'}`
  }
  if (jev?.person && !decided.fields?.full_name && !decided.fields?.passport_number) {
    decided.fields = { ...(decided.fields || {}), full_name: jev.person.full_name, ...(jev.person.passport_number ? { passport_number: jev.person.passport_number } : {}) }
  }
  return decided
}

async function analyzeUsual(originalPath, filename) {
  const local = await analyzeLocally(originalPath)
  if (local?.doc_type) return local

  let text = local?.text || '' // PDF text layer, when there is one

  // 1. Gemini reads the file itself (images, scans) or the PDF's text layer.
  let result = null
  let source = 'gemini'
  try {
    result = await classifyWithGemini(text ? { text, filename } : { filePath: originalPath, filename })
  } catch (e) {
    console.warn('[classify] Gemini could not read the file, trying MinerU:', e.message)
  }

  // 2. Gemini failed: MinerU reads the text, Gemini classifies it, keyword rules last.
  if (!result) {
    if (!text) {
      const markdown = await parseDocumentToMarkdown(originalPath)
      text = String(markdown || '')
    }
    if (text.replace(/!\[[^\]]*\]\([^)]*\)|<[^>]+>|\s/g, '').length < 10) {
      // Nothing readable: an image of a person/object is a personal photo.
      if (IMAGE_EXT.test(originalPath)) return { doc_type: 'Photo', confidence: 0.6, fields: {}, markdown: '' }
      throw new Error('MinerU returned no usable text')
    }
    try {
      result = await classifyWithGemini({ text, filename })
      source = 'gemini-text'
    } catch (e) {
      console.warn('[classify] Gemini text classification failed, using keyword rules:', e.message)
      result = { ...classifyMarkdown(text), fields: {} }
      source = 'rules'
    }
  }

  // A picture with only a few stray words (no document keywords) is a photo too.
  if (result.doc_type === 'other' && IMAGE_EXT.test(originalPath) && wordCount(text) < 12) {
    return { doc_type: 'Photo', confidence: 0.5, fields: {}, markdown: text, source: 'text-count' }
  }
  return finishResult(result, text, source)
}

/** Passport fields from two MRZ lines, only when the check digits verify. */
function passportFromLines(lines) {
  if (!lines) return null
  const p = parseTD3(`${lines[0].padEnd(44, '<').slice(0, 44)}\n${fitLine2(lines[1])}`)
  if (!p || !p.overall_verified) return null
  return {
    surname: p.surname,
    given_names: p.given_names,
    full_name: `${p.given_names} ${p.surname}`.trim(),
    passport_number: p.passport_number,
    date_of_birth: p.date_of_birth,
    date_of_expiry: p.date_of_expiry,
    sex: p.sex,
    gender: p.sex,
    nationality: p.nationality_code,
  }
}

/**
 * The MRZ is the only trusted source for a passport number and dates. A passport
 * whose MRZ check digits verify takes its fields from the MRZ, whatever the model
 * said. Without a verified MRZ, a passport is capped at 0.6 (the pipeline reports it).
 */
function finishResult(result, text, source) {
  const found = findMrz(text)
  const lines = result.mrzLines || (found ? [found.line1, found.line2] : null)
  const mrzFields = passportFromLines(lines)

  let out = { doc_type: result.doc_type, confidence: result.confidence, fields: result.fields || {} }
  if (mrzFields) {
    out = { doc_type: 'Passport', confidence: 0.98, fields: { ...out.fields, ...mrzFields } }
  } else if (out.doc_type === 'Passport') {
    out = { ...out, confidence: Math.min(out.confidence || 0, 0.6) }
  }
  const markdown = text || (lines ? `${lines[0]}\n${lines[1]}` : '')
  return { ...out, markdown, source }
}

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|gif)$/i
function wordCount(text) {
  return text.replace(/!\[[^\]]*\]\([^)]*\)|<[^>]+>/g, ' ').split(/\s+/).filter(w => /[A-Za-z0-9\u1200-\u137F]{2,}/.test(w)).length
}

export default { classifyMarkdown, analyzeWithMineru }
