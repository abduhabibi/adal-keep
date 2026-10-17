/**
 * mineruAnalyzer.js
 *
 * Document classifier that uses **MinerU** for the OCR/reading step and
 * DeepSeek's text model for the classification step.
 *
 * Why: MinerU is a layout-aware parser (tables, columns, rotated scans,
 * Arabic/Amharic pages) and returns clean Markdown — much better raw text
 * than rasterising a PDF page and asking a vision model to read it.
 * DeepSeek then only has to *reason* over text, which is faster and cheaper.
 *
 * Drop-in compatible with `analyzeDocument()` from deepseekVision.js:
 * both return `{ doc_type, confidence, fields }`.
 */

import fs from 'fs'
import { getSecret } from './secretStore.js'
import { FIELD_NAMES, tryParse, normalizeResult } from './deepseekVision.js'
import { parseDocumentToMarkdown, isMineruConfigured } from './mineruClient.js'

export { isMineruConfigured, getDeepSeekKey }

const DEEPSEEK_URL = 'https://api.deepseek.com/v1/chat/completions'

// Cap the text we send to DeepSeek (deepseek-chat has a 64k context).
const MAX_TEXT_CHARS = Number(process.env.MINERU_MAX_TEXT_CHARS) || 30000

function getDeepSeekKey() {
  return getSecret('DEEPSEEK_API_KEY') || process.env.DEEPSEEK_API_KEY || ''
}

/** True when the MinerU analyzer should be attempted first. */
export function isMineruEnabled() {
  return isMineruConfigured()
}

const SYSTEM_PROMPT = `You are an OCR + data-extraction engine for an Ethiopian overseas-employment agency. You are given the full TEXT of one document, extracted by a layout-aware OCR engine (MinerU).

Return ONLY a JSON object. No prose. No markdown fences. No reasoning.

{"doc_type":"...","confidence":0.0,"fields":{...}}

doc_type MUST be EXACTLY one of these strings (case-sensitive):
${FIELD_NAMES.join(' | ')}

CLASSIFICATION RULES:
- Passport: bilingual Ethiopian passport data page with two MRZ lines starting with P<.
- Government ID: Ethiopian kebele ID or national ID card.
- Medical Report: hospital letter, "fit for work", blood group, chest x-ray.
- Visa: entry visa page (Saudi/Kuwait/etc.).
- Police Clearance: "Certificate of Good Conduct".
- COC: "Certificate of Competence".
- Saudi-letter: Saudi embassy/consulate letter.
- Musaned: Saudi Musaned platform document.
- Broker ID: broker/agent identification.
- Ticket-ongoing / Ticket-deported: airline ticket.
- Labour ID / Employee ID / Client ID: respective ID cards.
- Slip: bank/payment receipt (has "Order ID", "Reference", "Debit Account", "Credit Account", or "SWIFT").
- Experience Form: employment experience letter.
- Insurance: insurance policy.
- CV: "Curriculum Vitae" / "Resume" / "Experience" / "Education".
- Contract: "Employment Contract" / "Employer Name".
- Self Video / Photo: only for a portrait or video thumbnail.
- other: unclear, unreadable, or none of the above.

fields SCHEMA (all optional, use "" if not present):
{
  "given_names":     "Ethiopian given names, 1-3 words, original order",
  "middle_name":     "extra given names (father's name in Ethiopian convention)",
  "surname":         "family name",
  "given_names_am":  "Amharic given names if visible",
  "surname_am":      "Amharic surname if visible",
  "full_name":       "given_names + ' ' + surname (Latin only)",
  "passport_number": "",
  "national_id":     "",
  "phone_number":    "Ethiopian only (09/07/+251); null if none",
  "date_of_birth":   "YYYY-MM-DD",
  "date_of_issue":   "YYYY-MM-DD",
  "date_of_expiry":  "YYYY-MM-DD",
  "place_of_birth":  "",
  "sex":             "M or F",
  "nationality":     "",
  "employee_name":   "for contracts",
  "employer_name":   "for contracts",
  "contract_number": "",
  "visa_number":     "",
  "medical_result":  "",
  "reference_name":  "Slips only — the WORKER this payment is for",
  "customer_name":   "Slips only — the payer (sponsor), NOT the worker",
  "order_id":        "Slips only",
  "notes":           ""
}

NAME EXTRACTION (Ethiopian convention):
- Given names FIRST, surname LAST. "MIHRET TUMISO DEBOCH" → given_names="MIHRET TUMISO", surname="DEBOCH".
- full_name = given_names + " " + surname.
- Passports: MRZ (P<ETH... line) is ground truth if legible.
- Amharic: copy glyphs, do not transliterate.
- Never invent. If unreadable, set to null.
- Slips: full_name MUST equal reference_name, NOT customer_name.

DATES:
- Always YYYY-MM-DD. Ethiopian format "19 DEC 22" and "16.03.2026" both occur.

PHONES:
- Ethiopian mobiles only: 09xxxxxxxx, 07xxxxxxxx, +2519xxxxxxxx, +2517xxxxxxxx.
- Saudi numbers (+966) → null.

TEXT QUALITY:
- OCR text may contain artefacts, stray symbols and merged table cells. Read through the noise.
- Never hallucinate a value that is not supported by the text.

Return ONLY the JSON object.`

// ---------- DeepSeek text call with retries ----------

async function askDeepSeek(key, body) {
  const MAX_ATTEMPTS = 3
  let lastErr = null

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 90000)
    try {
      const res = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      clearTimeout(to)

      if (!res.ok) {
        const errText = await res.text()
        throw new Error(`DeepSeek HTTP ${res.status}: ${errText.slice(0, 300)}`)
      }
      return await res.json()
    } catch (e) {
      clearTimeout(to)
      lastErr = e
      const c = e.cause || {}
      console.warn(`[mineru] DeepSeek attempt ${attempt} failed: ${e.message}` +
        (c.code ? ` code=${c.code}` : ''))
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1200 * attempt))
    }
  }
  throw new Error('DeepSeek text call failed after retries: ' + (lastErr?.message || 'unknown'))
}

// ---------- main entry ----------

/**
 * Classify a document using MinerU (OCR) + DeepSeek (reasoning).
 * Same signature/return shape as deepseekVision.analyzeDocument().
 *
 * @param {string}  filePath      prepared image path (PDFs already rasterised)
 * @param {string}  filename      original filename
 * @param {string} [mimeType]     mime of `filePath` (unused — MinerU sniffs bytes)
 * @param {string} [originalPath] staged *original* file; used for PDFs so
 *                                MinerU can parse every page instead of page 1
 * @returns {Promise<{doc_type:string, confidence:number, fields:object}>}
 */
export async function analyzeDocumentWithMineru(filePath, filename, mimeType = 'image/jpeg', originalPath = null) {
  const key = getDeepSeekKey()
  if (!key) throw new Error('DEEPSEEK_API_KEY not configured')

  // Prefer the original file: MinerU parses full PDFs natively.
  const target = (originalPath && fs.existsSync(originalPath)) ? originalPath : filePath

  const markdown = await parseDocumentToMarkdown(target)
  if (text.length < 10) throw new Error('MinerU returned no usable text')
  console.log(`[mineru] ${filename}: ${text.length} chars of markdown → classifying`)
  return classifyTextWithDeepSeek(key, text, filename)
}

/**
 * DeepSeek classification of document text (MinerU markdown or a PDF's text
 * layer). Returns { doc_type, confidence, fields } using the field list above.
 */
export async function classifyTextWithDeepSeek(key, text, filename) {
  const model = process.env.AI_MODEL || 'deepseek-chat'

  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Filename: ${filename}\n\n` +
          `===== DOCUMENT TEXT =====\n` +
          `${text.slice(0, MAX_TEXT_CHARS)}\n` +
          `===== END DOCUMENT TEXT =====\n\n` +
          `Return JSON only.`,
      },
    ],
    max_tokens: 4000,
    temperature: 0.0,
  }

  const data = await askDeepSeek(key, body)
  const msg = data.choices?.[0]?.message || {}
  const content = msg.content || ''
  const reasoning = msg.reasoning_content || ''

  let parsed = tryParse(content)
  if (!parsed && reasoning) parsed = tryParse(reasoning)
  if (!parsed) throw new Error('No JSON in DeepSeek response')
  return normalizeResult(parsed)
}

/**
 * Analyzer used by the ingestion pipeline.
 * Tries MinerU first (when configured) and transparently falls back to the
 * DeepSeek vision analyzer on any error or empty result — so enabling MinerU
 * can never break the existing flow.
 */
export async function analyzeDocumentSmart(filePath, filename, mimeType = 'image/jpeg', originalPath = null) {
  if (!isMineruConfigured()) {
    const { analyzeDocument } = await import('./deepseekVision.js')
    return analyzeDocument(filePath, filename, mimeType)
  }

  try {
    const result = await analyzeDocumentWithMineru(filePath, filename, mimeType, originalPath)
    if (result && result.doc_type && result.doc_type !== 'other') return result
    console.warn('[mineru] result unusable — falling back to DeepSeek vision')
  } catch (e) {
    console.warn('[mineru] failed, falling back to DeepSeek vision:', e.message)
  }

  const { analyzeDocument } = await import('./deepseekVision.js')
  return analyzeDocument(filePath, filename, mimeType)
}

export default { analyzeDocumentWithMineru, analyzeDocumentSmart, isMineruEnabled }
