import fs from 'fs'
import os from 'os'
import path from 'path'
import { getSecret } from './secretStore.js'

const SYSTEM_PROMPT = `You convert scanned employment-agency CV forms into reusable HTML templates.

You receive ONE scanned CV from an Ethiopian overseas-employment agency (Arabic/English side-by-side, with a passport photo, a full-body photo, a table of applicant details, and a passport box). Output a single JSON object.

STEP 1 — Reproduce the layout as clean standalone HTML + CSS.
STEP 2 — Replace every field VALUE with one of the {{PLACEHOLDER}} tokens below.
STEP 3 — Do NOT invent new placeholders.

ALLOWED PLACEHOLDERS:
Personal: {{FULL_NAME}} {{GIVEN_NAMES}} {{SURNAME}} {{NATIONALITY}} {{SEX}} {{AGE}} {{DOB}}
Identity: {{PASSPORT_NO}} {{PLACE_OF_BIRTH}} {{RELIGION}} {{MARITAL_STATUS}} {{CHILDREN_COUNT}}
Physical: {{WEIGHT}} {{HEIGHT}} {{COMPLEXION}} {{LIVING_TOWN}}
Family: {{MOTHER_NAME}} {{FATHER_NAME}} {{SPOUSE_NAME}}
Contact: {{PHONE}} {{EDUCATION}} {{ENGLISH}} {{ARABIC}}
Languages (a Speak / Read / Write grid — one token per cell, value YES or NO): {{ENGLISH_SPEAK}} {{ENGLISH_READ}} {{ENGLISH_WRITE}} {{ARABIC_SPEAK}} {{ARABIC_READ}} {{ARABIC_WRITE}}
  ({{ENGLISH}} / {{ARABIC}} alone is one cell, e.g. "SPEAK, READ" or "NO")
Job: {{POST_APPLIED}} {{SALARY}} {{CURRENCY}} {{COUNTRY}} {{CONTRACT_YEARS}} {{REF_NO}} {{DATE_TODAY}}
Skills: {{SKILL_CLEANING}} {{SKILL_IRONING}} {{SKILL_WASHING}} {{SKILL_BABY_SITTING}} {{SKILL_COOKING}}
Previous: {{PREV_COUNTRY}} {{PREV_PERIOD}} {{PREV_POSITION}}
Media: {{PHOTO_URL}} {{FULL_BODY_PHOTO_URL}} {{HEADER_IMAGE}} {{FOOTER_IMAGE}}

HTML RULES:
- One standalone document: <!DOCTYPE html><html><head><style>…</style></head><body>…</body></html>.
- Fixed A4 page: html, body { width: 210mm; margin: 0; padding: 10mm; box-sizing: border-box; }
- Reproduce table borders, background colours, fonts, spacing exactly as in the image.
- Preserve Arabic and Amharic text as-is (right-to-left direction on Arabic cells is fine).
- Do NOT render any agency header or logo at the top of the page — the system injects it automatically.
- Do NOT render any footer at the bottom of the page — the system injects it automatically.
- Replace the headshot with <img src="{{PHOTO_URL}}" ...> and the full body with <img src="{{FULL_BODY_PHOTO_URL}}" ...>.
- Skill cells should render the token — value will be "✓" or "".
- Fonts: Arial, Helvetica, sans-serif. Do NOT load external fonts.
- No external scripts, no external CSS, no @import.

EXTRACT META:
- name: short Latin identifier, uppercase (e.g. "AL-SHAHD ALMASI", "MATRA AL-RIHAN")
- agency_name: full Latin agency name as printed
- agency_name_ar: Arabic name if visible, else ""
- salary: numeric monthly salary from the form (e.g. 1000). 0 if unclear.
- currency: "SAR" or "KWD" or "USD" etc.
- country: 2-letter code — SA (Saudi), KW (Kuwait), AE, QA, BH, OM, JO
- contract_years: integer (default 2)

Return ONLY this JSON, no markdown, no commentary:
{"name":"...","agency_name":"...","agency_name_ar":"...","salary":1000,"currency":"SAR","country":"SA","contract_years":2,"html":"<!DOCTYPE html>…","css":""}`

async function renderPdfToPng(pdfPath, pageIndex = 0, scale = 3) {
  const mupdf = await import('mupdf')
  const data = fs.readFileSync(pdfPath)
  const doc = mupdf.Document.openDocument(data, 'application/pdf')
  if (doc.countPages() === 0 || pageIndex >= doc.countPages()) return null
  const page = doc.loadPage(pageIndex)
  const pix = page.toPixmap([scale, 0, 0, scale, 0, 0], mupdf.ColorSpace.DeviceRGB, false, true)
  const out = path.join(os.tmpdir(), `cv_tpl_${Date.now()}_${pageIndex}.png`)
  fs.writeFileSync(out, Buffer.from(pix.asPNG()))
  return out
}

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
    else if (c === '}') { depth--; if (depth === 0) return str.slice(start, i + 1) }
  }
  return null
}

export async function ingestTemplate(filePath, filename, mime) {
  const key = getSecret('DEEPSEEK_API_KEY') || process.env.DEEPSEEK_API_KEY
  if (!key) throw new Error('DEEPSEEK_API_KEY not configured')

  // PDF → first-page PNG
  let imagePath = filePath
  let imageMime = mime || 'image/jpeg'
  let tmp = null
  if (path.extname(filename).toLowerCase() === '.pdf') {
    tmp = await renderPdfToPng(filePath, 0, 3)
    if (!tmp) throw new Error('Could not render PDF')
    imagePath = tmp
    imageMime = 'image/png'
  }

  const b64 = fs.readFileSync(imagePath).toString('base64')
  const dataUrl = `data:${imageMime};base64,${b64}`

  const body = {
    model: process.env.AI_VISION_MODEL || 'deepseek-flash',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: [
        { type: 'text', text: `Template filename: ${filename}\n\nReturn JSON only.` },
        { type: 'image_url', image_url: { url: dataUrl, detail: 'high' } }
      ]}
    ],
    max_tokens: 16000,
    temperature: 0.1,
  }

  let lastErr = null
  let res = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ac = new AbortController()
    const to = setTimeout(() => ac.abort(), 240000)
    try {
      res = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      clearTimeout(to)
      break
    } catch (e) {
      clearTimeout(to)
      lastErr = e
      if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt))
    }
  }
  if (tmp) try { fs.unlinkSync(tmp) } catch {}
  if (!res) throw new Error('DeepSeek fetch failed: ' + (lastErr?.cause?.code || lastErr?.message))

  if (!res.ok) {
    const t = await res.text()
    throw new Error(`DeepSeek HTTP ${res.status}: ${t.slice(0, 300)}`)
  }
  const data = await res.json()
  const msg = data.choices?.[0]?.message || {}
  const content = msg.content || msg.reasoning_content || ''
  const bal = extractBalancedJSON(content)
  if (!bal) throw new Error('No JSON in DeepSeek response: ' + content.slice(0, 200))

  let parsed
  try { parsed = JSON.parse(bal) } catch (e) { throw new Error('Malformed JSON: ' + bal.slice(0, 200)) }

  return {
    name: String(parsed.name || filename.replace(/\.[^.]+$/, '')).trim().toUpperCase(),
    agency_name: parsed.agency_name || '',
    agency_name_ar: parsed.agency_name_ar || '',
    salary: parseInt(parsed.salary, 10) || 0,
    currency: (parsed.currency || 'SAR').toUpperCase(),
    country: (parsed.country || '').toUpperCase(),
    contract_years: parseInt(parsed.contract_years, 10) || 2,
    html_content: parsed.html || '',
    css_content: parsed.css || '',
    placeholders: JSON.stringify(
      Array.from(new Set((parsed.html || '').match(/\{\{[A-Z_]+\}\}/g) || []))
    ),
  }
}
