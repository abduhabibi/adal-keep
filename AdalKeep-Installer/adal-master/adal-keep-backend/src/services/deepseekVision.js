import fs from 'fs'
import { getSecret } from './secretStore.js'

export const FIELD_NAMES = [
  'Government ID', 'Passport', 'CV', 'Contract', 'Medical Report', 'Insurance',
  'COC', 'Visa', 'Saudi-letter', 'Musaned', 'Broker ID', 'Ticket-ongoing',
  'Ticket-deported', 'Police Clearance', 'Labour ID', 'Slip', 'Experience Form',
  'Employee ID', 'Client ID', 'Self Video', 'Photo', 'other'
]

const SYSTEM_PROMPT = `You are an OCR + data-extraction engine for an Ethiopian overseas-employment agency. Read the attached image and return structured JSON.

Return ONLY a JSON object. No prose. No markdown fences. No reasoning.

{"doc_type":"...","confidence":0.0,"fields":{...}}

doc_type MUST be EXACTLY one of these strings (case-sensitive):
Government ID | Passport | CV | Contract | Medical Report | Insurance | COC | Visa | Saudi-letter | Musaned | Broker ID | Ticket-ongoing | Ticket-deported | Police Clearance | Labour ID | Slip | Experience Form | Employee ID | Client ID | Self Video | Photo | other

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
- Self Video / Photo: only if the file is clearly a portrait or video thumb.
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
  "photo_bbox":      [0, 0, 0, 0],
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

PASSPORT PHOTO BBOX (passports only):
"photo_bbox": [x, y, w, h] — fractions of image dimensions, 0.0-1.0.
If you cannot identify the photo, return [0, 0, 0, 0].

DATES:
- Always YYYY-MM-DD. Ethiopian format "19 DEC 22" and "16.03.2026" both occur.

PHONES:
- Ethiopian mobiles only: 09xxxxxxxx, 07xxxxxxxx, +2519xxxxxxxx, +2517xxxxxxxx.
- Saudi numbers (+966) → null.

IMAGES:
- May be rotated. Read whatever orientation it appears.
- May be low-resolution. Do your best; do not hallucinate.

Return ONLY the JSON object.`

// ---------- helpers ----------

// Walk a string and grab the first balanced {...} block
function extractBalancedJSON(str) {
  if (!str) return null
  const start = str.indexOf('{')
  if (start === -1) return null
  let depth = 0, inStr = false, esc = false
  for (let i = start; i < str.length; i++) {
    const c = str[i]
    if (inStr) {
      if (esc) { esc = false; continue }
      if (c === '\\') { esc = true; continue }
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; continue }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return str.slice(start, i + 1)
    }
  }
  return null
}

// Try several parsing strategies on a raw string
function tryParse(raw) {
  if (!raw) return null
  try { return JSON.parse(raw) } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) { try { return JSON.parse(fenced[1].trim()) } catch {} }
  const bal = extractBalancedJSON(raw)
  if (bal) { try { return JSON.parse(bal) } catch {} }
  return null
}

// Try to find a valid doc_type in a parsed object, ignoring junk values
function pickDocType(obj) {
  const candidates = [obj.doc_type, obj.type, obj.document_type, obj.documentType, obj.docType]
  for (const v of candidates) {
    if (!v) continue
    const s = String(v).trim()
    if (!s) continue
    // Reject obvious non-types
    if (s.toLowerCase() === 'json_object') continue
    if (s.toLowerCase() === 'json') continue
    if (s.toLowerCase() === 'object') continue
    // Case-insensitive match against the canonical list
    const match = FIELD_NAMES.find(n => n.toLowerCase() === s.toLowerCase())
    if (match) return match
  }
  // No match — try "other"
  return null
}

// ---------- main entry ----------

export async function analyzeDocument(imagePath, filename, mimeType = 'image/jpeg') {
  const key = getSecret('DEEPSEEK_API_KEY') || process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY not configured')

  const buf = fs.readFileSync(imagePath)
  const b64 = buf.toString('base64')
  const dataUrl = `data:${mimeType};base64,${b64}`

  const model = process.env.AI_VISION_MODEL || 'deepseek-flash'

  // NOTE: no response_format — DeepSeek echoes it back as a "doc_type" value
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `Filename: ${filename}\n\nReturn JSON only.` },
          { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
        ]
      }
    ],
    max_tokens: 4000,
    temperature: 0.0
  }

  // ---------- HTTP with retries ----------
  const MAX_ATTEMPTS = 3
  let res = null
  let lastErr = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 90000)
    try {
      res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ac.signal
      })
      clearTimeout(to)
      break
    } catch (e) {
      clearTimeout(to)
      lastErr = e
      const c = e.cause || {}
      console.warn(`[vision] attempt ${attempt} failed: ${e.message}` +
        (c.code ? ` code=${c.code}` : '') +
        (c.syscall ? ` syscall=${c.syscall}` : ''))
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 1200 * attempt))
    }
  }
  if (!res) throw new Error('DeepSeek fetch failed after retries: ' + (lastErr?.cause?.code || lastErr?.message))

  if (!res.ok) {
    const errText = await res.text()
    throw new Error(`DeepSeek vision HTTP ${res.status}: ${errText.slice(0, 300)}`)
  }

  // ---------- parse ----------
  const data = await res.json()
  const msg = data.choices?.[0]?.message || {}
  const content = msg.content || ''
  const reasoning = msg.reasoning_content || ''

  let parsed = tryParse(content)
  if (!parsed && reasoning) parsed = tryParse(reasoning)

  if (!parsed) {
    console.error('[vision] no parseable JSON')
    console.error('  content head:', content.slice(0, 300))
    console.error('  reasoning head:', reasoning.slice(0, 300))
    throw new Error('No JSON in DeepSeek response')
  }

  // ---------- normalize ----------
  // fields can arrive under several keys
  if (!parsed.fields && parsed.data) parsed.fields = parsed.data
  if (!parsed.fields && parsed.extracted) parsed.fields = parsed.extracted
  // If the model put everything at the top level, wrap it
  if (!parsed.fields) {
    const known = ['given_names','middle_name','surname','given_names_am','surname_am','full_name',
      'passport_number','national_id','phone_number','date_of_birth','date_of_issue','date_of_expiry',
      'place_of_birth','sex','nationality','employee_name','employer_name','contract_number',
      'visa_number','medical_result','photo_bbox','reference_name','customer_name','order_id','notes']
    const extracted = {}
    for (const k of known) if (parsed[k] !== undefined) extracted[k] = parsed[k]
    if (Object.keys(extracted).length > 0) parsed.fields = extracted
  }
  parsed.fields = parsed.fields || {}

  // doc_type: pick a valid value across all possible keys
  const docType = pickDocType(parsed)
  parsed.doc_type = docType || 'other'
  parsed.confidence = parseFloat(parsed.confidence) || (docType ? 0.85 : 0)

  if (!docType) {
    console.warn('[vision] no valid doc_type in response — dumped keys:')
    console.warn('  parsed keys:', Object.keys(parsed).join(', '))
    console.warn('  raw doc_type:', JSON.stringify(parsed.doc_type))
  }

  return parsed
}