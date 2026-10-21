/**
 * geminiClassifier.js
 *
 * Document classification and field extraction with Google Gemini.
 *
 * Gemini reads either the file itself (images, scans) or the text already
 * extracted from it (PDF text layer, MinerU output). It answers with JSON:
 * doc_type, confidence, fields and, for passports, the two MRZ lines as printed.
 *
 * Model order: GEMINI_MODEL (default gemini-3.6-flash: a document in seconds),
 * then gemini-3.8-flash (as good, but it took 20 s to 2 min per answer on
 * 2026-10-19) and the Flash-Lite models. A temporary error (503 / 429) is
 * retried; a model that is retired, unavailable or slower than CALL_TIMEOUT_MS
 * moves on to the next one.
 */

import fs from 'fs'
import path from 'path'
import { FIELD_NAMES, tryParse, normalizeResult } from './deepseekVision.js'
import { setStage } from './ingestQueue.js'

const API = 'https://generativelanguage.googleapis.com/v1beta/models'
const MODELS = [...new Set([
  process.env.GEMINI_MODEL || 'gemini-3.6-flash',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
])]

// One answer may take this long; then the next model is asked. Files are
// sorted one at a time, so a slow model holds up every file behind it.
const CALL_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 45000)

// Inline file uploads are capped by the API at about 20 MB per request.
const MAX_INLINE_BYTES = 18 * 1024 * 1024

const MIME = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

// Keys: GEMINI_API_KEY, then the backups in GEMINI_API_KEYS (comma-separated).
// A key that runs out of quota or is refused rests and the next one is used.
function geminiKeys() {
  return [...new Set([process.env.GEMINI_API_KEY, ...String(process.env.GEMINI_API_KEYS || '').split(/[,;\s]+/)]
    .map(k => String(k || '').trim()).filter(Boolean))]
}
const resting = new Map() // key → time it may be used again
let keyAt = 0

function pickKey() {
  const keys = geminiKeys()
  for (let i = 0; i < keys.length; i++) {
    const k = keys[(keyAt + i) % keys.length]
    if ((resting.get(k) || 0) <= Date.now()) { keyAt = (keyAt + i) % keys.length; return k }
  }
  return keys[keyAt % keys.length] // all resting: try the current one anyway
}

function restKey(key, ms, why) {
  const keys = geminiKeys()
  resting.set(key, Date.now() + ms)
  keyAt = (keys.indexOf(key) + 1) % keys.length
  console.warn(`[classify] Gemini key ${keys.indexOf(key) + 1} of ${keys.length} ${why} — using key ${keyAt + 1} for now`)
}

export function isGeminiConfigured() {
  return geminiKeys().length > 0
}

const PROMPT = `You classify and read documents for an Ethiopian overseas-employment agency.

Return ONLY one JSON object, no prose, no markdown:
{"doc_type":"...","confidence":0.0,"fields":{...},"mrz_line1":"","mrz_line2":""}

doc_type must be EXACTLY one of these strings (case-sensitive):
${FIELD_NAMES.join(' | ')}

Classification guide:
- Passport: an Ethiopian passport data page (bilingual, with a PASSPORT heading and a machine-readable zone).
- Government ID: Ethiopian kebele or national ID card.
- Medical Report: hospital letter, fit for work, blood group, chest x-ray.
- Visa: entry visa page. Police Clearance: "Certificate of Good Conduct" / police clearance.
- COC: certificate of competence. Saudi-letter: Saudi embassy or consulate letter.
- Musaned: Saudi Musaned platform document. Broker ID: broker or agent identification.
- Ticket-ongoing / Ticket-deported: airline ticket (deported when the document says so).
- Labour ID / Employee ID / Client ID: the matching ID card.
- Slip: bank or payment receipt (Order ID, Debit/Credit Account, SWIFT, CBE, Birr, transfer receipt).
- Experience Form: employment experience letter. Insurance: insurance policy.
- CV: curriculum vitae / resume. Contract: employment contract (employer name, employee name).
- Photo: a personal photograph of a person with no printed document text.
- other: none of the above, or unreadable.

fields (use null for anything not present, never invent a value):
{"given_names":"","middle_name":"","surname":"","full_name":"","passport_number":"","national_id":"",
 "date_of_birth":"YYYY-MM-DD","date_of_issue":"YYYY-MM-DD","date_of_expiry":"YYYY-MM-DD",
 "place_of_birth":"","sex":"M or F","nationality":"","phone_number":"","employee_name":"","employer_name":"",
 "contract_number":"","visa_number":"","reference_name":"","customer_name":"","order_id":"","notes":""}

Names: Ethiopian order, given names first and surname last. full_name = given_names + " " + surname (Latin letters).
Dates: always YYYY-MM-DD. Ethiopian dates like 19 DEC 22 or 16.03.2026 are converted.
Slips: full_name and reference_name are the worker the payment is for, not the payer.

Passports only: copy the two machine-readable lines EXACTLY as printed, 44 characters each, into
mrz_line1 and mrz_line2 (use < for filler). If they are not visible, leave both empty.`

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

/** One generateContent call with model fallback and retries for temporary errors. */
async function generate(parts, models = MODELS, { system = PROMPT, json = true } = {}) {
  if (!geminiKeys().length) throw new Error('GEMINI_API_KEY not configured')

  let lastErr = null
  for (const model of models) {
    if (system === PROMPT) setStage(`asking Gemini (${model})`)
    // Gemini 3 thinks before answering, and the thinking counts against
    // maxOutputTokens: at the default level it used the whole budget and cut
    // the JSON off. Low thinking is plenty for reading a document.
    let thinking = true
    let keySwitches = 0
    for (let attempt = 1; attempt <= 3; attempt++) {
      const key = pickKey()
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT_MS)
      try {
        const res = await fetch(`${API}/${model}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts }],
            generationConfig: {
              temperature: json ? 0 : 0.3, responseMimeType: json ? 'application/json' : 'text/plain', maxOutputTokens: 8192,
              ...(thinking ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
            },
          }),
          signal: ac.signal,
        })
        clearTimeout(timer)
        const data = await res.json().catch(() => ({}))
        if (res.ok) {
          const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('')
          if (!text) throw new Error(`Gemini ${model} returned no text`)
          if (data.candidates?.[0]?.finishReason === 'MAX_TOKENS') {
            // Cut off mid-answer: the JSON is incomplete. Next model.
            lastErr = new Error(`Gemini ${model} answer was cut off`)
            console.warn(`[classify] ${lastErr.message}`)
            break
          }
          return { text, model }
        }
        lastErr = new Error(`Gemini ${model} HTTP ${res.status}: ${String(data.error?.message || '').slice(0, 160)}`)
        console.warn(`[classify] ${lastErr.message}`)
        // This key is out of quota or refused: the next key, same model.
        const msg = String(data.error?.message || '')
        const keyProblem = res.status === 429 || res.status === 401 || res.status === 403 ||
          (res.status === 400 && /api key/i.test(msg))
        if (keyProblem && geminiKeys().length > 1 && keySwitches < geminiKeys().length) {
          keySwitches++
          restKey(key, res.status === 429 ? (/day|daily|per.?day/i.test(msg) ? 6 * 3600000 : 60000) : 6 * 3600000,
            res.status === 429 ? 'is out of quota' : 'was refused')
          attempt--
          continue
        }
        // A model without thinking levels: ask it again without the setting.
        if (res.status === 400 && thinking && /thinking/i.test(data.error?.message || '')) {
          thinking = false
          continue
        }
        // Temporary: wait and try the same model again. Anything else: next model.
        if (res.status === 503 || res.status === 429 || res.status >= 500) {
          await sleep(2000 * attempt)
          continue
        }
        break
      } catch (e) {
        clearTimeout(timer)
        if (ac.signal.aborted) {
          // Too slow: the next model, not the same one again.
          lastErr = new Error(`Gemini ${model} gave no answer within ${CALL_TIMEOUT_MS / 1000}s`)
          console.warn(`[classify] ${lastErr.message}`)
          break
        }
        lastErr = e
        await sleep(2000 * attempt)
      }
    }
  }
  throw lastErr || new Error('Gemini: no model answered')
}

/**
 * Classify a document.
 * @param {object} input
 * @param {string} [input.text]       text already extracted from the document
 * @param {string} [input.filePath]   the file itself (images, scans, PDFs)
 * @param {string} input.filename
 * @returns {Promise<{doc_type:string, confidence:number, fields:object, mrzLines:string[]|null, model:string}>}
 */
export async function classifyWithGemini({ text = '', filePath = null, filename, models }) {
  const parts = [{ text: `Filename: ${filename}` }]

  if (filePath) {
    const size = fs.statSync(filePath).size
    if (size > MAX_INLINE_BYTES) throw new Error(`file too large for inline upload (${Math.round(size / 1048576)} MB)`)
    const mime = MIME[path.extname(filePath).toLowerCase()]
    if (!mime) throw new Error(`no MIME type for ${path.extname(filePath)}`)
    parts.push({ inline_data: { mime_type: mime, data: fs.readFileSync(filePath).toString('base64') } })
  }
  if (text) {
    parts.push({ text: `===== DOCUMENT TEXT =====\n${text.slice(0, 30000)}\n===== END DOCUMENT TEXT =====` })
  }
  parts.push({ text: 'Return the JSON object only.' })

  const t0 = Date.now()
  const { text: out, model } = await generate(parts, models)
  console.log(`[classify] Gemini ${model} answered in ${Date.now() - t0}ms`)
  const parsed = tryParse(out)
  if (!parsed) throw new Error(`no JSON in Gemini answer (${model})`)

  const mrzLines = [parsed.mrz_line1, parsed.mrz_line2]
    .map(l => String(l || '').replace(/\s+/g, '').toUpperCase())
  const result = normalizeResult(parsed)
  return {
    doc_type: result.doc_type,
    confidence: result.confidence,
    fields: result.fields || {},
    mrzLines: mrzLines[0] && mrzLines[1] ? mrzLines : null,
    model,
  }
}

/**
 * A short plain-text answer (used by the in-app tutor). Same keys, models and
 * fallbacks as classification. Throws when no model answers.
 */
export async function askGemini(system, question) {
  const { text } = await generate([{ text: question }], MODELS, { system, json: false })
  return text.trim()
}

export default { classifyWithGemini, isGeminiConfigured, askGemini }
