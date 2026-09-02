import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { grok, models } from './grokClient.js'

const execFileAsync = promisify(execFile)

export const FIELD_SLOTS = [
  'Passport', 'Government ID', 'CV', 'Contract', 'Medical Report',
  'Insurance', 'COC', 'Visa', 'Saudi-letter', 'Certificate', 'Other'
]

// Security: Strict allowed extensions and max size (cost + safety)
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.webp']);
const MAX_SIZE_BYTES = 12 * 1024 * 1024; // 12MB

/** Secure + efficient conversion to vision payload. Rasterizes only first page of PDF. */
async function toVisionPayload(filePath, mimeType) {
  const ext = path.extname(filePath).toLowerCase()

  // Security: Validate file extension
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Forbidden file type: ${ext}`)
  }

  // For images, read directly (cheapest)
  if (ext !== '.pdf' && mimeType !== 'application/pdf') {
    const buffer = await fs.readFile(filePath)
    return { base64: buffer.toString('base64'), mimeType: mimeType || 'image/jpeg' }
  }

  // PDF → PNG (only page 1, 150 DPI = good quality, low cost)
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adal-pdf-'))
  const outPrefix = path.join(tmpDir, 'page')
  try {
    await execFileAsync('pdftoppm', [
      '-png', '-f', '1', '-l', '1', '-singlefile', '-r', '150',
      filePath, outPrefix
    ])
    const pngPath = `${outPrefix}.png`
    const buffer = await fs.readFile(pngPath)
    return { base64: buffer.toString('base64'), mimeType: 'image/png' }
  } finally {
    // Cleanup temp files securely
    try {
      const files = await fs.readdir(tmpDir)
      await Promise.all(files.map(f => fs.unlink(path.join(tmpDir, f)).catch(() => {})))
      await fs.rmdir(tmpDir).catch(() => {})
    } catch {}
  }
}

export async function classifyDocument(filePath, mimeType = 'image/jpeg') {
  if (!grok) {
    return { field: 'Other', confidence: 0, reason: 'No XAI_API_KEY', extracted: {} }
  }

  const filename = path.basename(filePath)

  // Security & cost protection
  let stat;
  try {
    stat = await fs.stat(filePath);
    if (stat.size > MAX_SIZE_BYTES) {
      return { field: 'Other', confidence: 0, reason: 'file too large', extracted: {} };
    }
    if (!ALLOWED_EXT.has(path.extname(filename).toLowerCase())) {
      return { field: 'Other', confidence: 0, reason: 'unsupported file type', extracted: {} };
    }
  } catch (err) {
    return { field: 'Other', confidence: 0, reason: 'cannot read file', extracted: {} };
  }

  let base64, visionMime;
  try {
    ({ base64, mimeType: visionMime } = await toVisionPayload(filePath, mimeType));
  } catch (err) {
    console.error('[docClassifier] rasterize error:', err.message);
    return {
      field: 'Other',
      confidence: 0,
      reason: `Cannot prepare image: ${err.message}`,
      extracted: {}
    };
  }

  const prompt = `You are an expert at classifying Ethiopian employment & immigration documents.

Classify the image into **exactly one** of these categories:
${FIELD_SLOTS.join(' | ')}

Strict classification rules (follow exactly):
- Passport: Official Ethiopian passport booklet, MRZ (P<ETH), photo + personal data page.
- Government ID: National ID card (Kebele, Fayda, new blue ID), old green ID.
- CV: Biodata, agency form, house maid contract, salary expectations, "Dar Basel", "Matra", resume-style document. Even if it contains a passport number.
- Contract: Employment contract or agreement.
- Medical Report: Doctor/lab reports, fitness for work, medical certificate.
- Insurance: Insurance policy or card.
- COC: Certificate of Competence / Conduct.
- Visa: Any visa sticker or approval letter.
- Saudi-letter: Letter from Saudi employer, embassy, or recruitment agency.
- Certificate: Educational certificate, training certificate, birth certificate.
- Self Video: Self-introduction video, selfie video, or profile video of the candidate.
- Photo: Portrait photo, passport-style photo, or any clear face photo of the candidate.
- Other: Everything else.

Extract visible identity fields accurately (especially name). For video and photo, name may appear on screen or in filename.

Return **valid JSON only**. No explanation, no markdown, no extra text.

Example output:
{"field":"CV","confidence":0.92,"reason":"agency biodata form with photo and skills","has_mrz":false,"looks_like_resume":true,"full_name":"Abebe Kebede","passport_number":"EP1234567","national_id":"123456789","date_of_birth":"1995-03-15","date_of_birth_ec":"1987-07-06","nationality":"Ethiopian","gender":"Female","phone_number":"251911223344","issued_date":"","expiry_date":""}`

  try {
    const res = await grok.chat.completions.create({
      model: models.vision,
      temperature: 0.0,           // deterministic = more consistent + cost effective
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${visionMime};base64,${base64}`, detail: 'high' } },
          { type: 'text', text: prompt }
        ]
      }]
    })

    const rawText = res.choices?.[0]?.message?.content || ''
    let data = {}

    // Robust JSON extraction - handles code blocks, extra text, thinking
    let jsonText = rawText.trim();
    const codeBlock = jsonText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (codeBlock) jsonText = codeBlock[1];
    const jsonMatch = jsonText.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      try {
        data = JSON.parse(jsonMatch[1].trim());
      } catch (e) {}
    }

    let field = (data.field || 'Other').trim();
    if (data.looks_like_resume && field === 'Passport') field = 'CV';
    if (data.has_mrz && !data.looks_like_resume && field === 'CV') field = 'Passport';
    if (!FIELD_SLOTS.includes(field)) field = 'Other';

    const confidence = Math.max(0.3, Number(data.confidence) || 0.65); // floor to avoid overconfidence in failures

    return {
      field,
      confidence,
      reason: data.reason || 'classified by vision model',
      extracted: {
        document_type: field === 'Passport' ? 'passport' :
                      field === 'Government ID' ? 'national_id' :
                      field === 'CV' ? 'cv' : 'other',
        full_name: String(data.full_name || '').trim(),
        passport_number: String(data.passport_number || '').trim(),
        national_id: String(data.national_id || '').trim(),
        date_of_birth: String(data.date_of_birth || '').trim(),
        date_of_birth_ec: String(data.date_of_birth_ec || '').trim(),
        nationality: String(data.nationality || '').trim(),
        gender: String(data.gender || '').trim(),
        phone_number: String(data.phone_number || '').trim(),
        issued_date: String(data.issued_date || '').trim(),
        expiry_date: String(data.expiry_date || '').trim(),
        confidence
      }
    }
  } catch (err) {
    console.error('[docClassifier] API error for', filename, ':', err.message);
    return { field: 'Other', confidence: 0, reason: err.message, extracted: {} };
  }
}

export default { classifyDocument, FIELD_SLOTS }
