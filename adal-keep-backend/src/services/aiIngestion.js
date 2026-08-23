import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { GoogleGenerativeAI } from '@google/generative-ai'
import chokidar from 'chokidar'
import db from '../config/database.js'
import logger from '../utils/logger.js'
import os from 'os'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCANS_DIR = path.join(os.homedir(), 'Downloads')
const PROCESSED_DIR = path.join(SCANS_DIR, 'AdalKeep-Processed')

const API_KEY = process.env.GEMINI_API_KEY
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.6'   // ← exactly as requested

if (!API_KEY) {
  console.warn('[AI] GEMINI_API_KEY is missing – AI features disabled')
}

const genAI = API_KEY ? new GoogleGenerativeAI(API_KEY) : null

async function ensureDirs() {
  await fs.mkdir(PROCESSED_DIR, { recursive: true })
}

/* ------------------------------------------------------------------ */
/* Core Gemini call                                                   */
/* ------------------------------------------------------------------ */
async function callGemini(parts, systemPrompt) {
  if (!genAI) throw new Error('Gemini not configured')

  const model = genAI.getGenerativeModel({
    model: MODEL,
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
    }
  })

  const result = await model.generateContent([
    { text: systemPrompt },
    ...parts
  ])

  const text = result.response.text()
  try {
    return JSON.parse(text)
  } catch {
    const match = text.match(/\{[\s\S]*\}/)
    if (match) return JSON.parse(match[0])
    throw new Error('Gemini did not return valid JSON: ' + text.slice(0, 200))
  }
}

/* ------------------------------------------------------------------ */
/* 1. extractProfileData  (used by WhatsApp route)                    */
/* ------------------------------------------------------------------ */
export async function extractProfileData({ text = '', imageBase64 = null, mimeType = 'image/jpeg' }) {
  const parts = []
  if (imageBase64) {
    parts.push({
      inlineData: { mimeType, data: imageBase64 }
    })
  }
  if (text) parts.push({ text })

  const prompt = `
You are an expert at reading Ethiopian passports, national IDs, voice-note transcripts and employment documents.
Extract the following fields and return ONLY valid JSON:

{
  "full_name": "",
  "passport_number": "",
  "national_id": "",
  "date_of_birth": "",
  "nationality": "",
  "gender": "",
  "phone_number": "",
  "issued_date": "",
  "expiry_date": "",
  "confidence": 0.0
}

Rules:
- Empty string if not clearly visible.
- confidence between 0 and 1.
- Prefer English transliteration for names.
- Dates as YYYY-MM-DD when possible.
`

  return callGemini(parts, prompt)
}

/* ------------------------------------------------------------------ */
/* 2. createOrUpdateProfile                                           */
/* ------------------------------------------------------------------ */
export async function createOrUpdateProfile(data = {}) {
  const payload = {
    full_name: data.full_name || data.name || 'Unknown',
    passport_number: data.passport_number || null,
    national_id: data.national_id || null,
    date_of_birth: data.date_of_birth || null,
    nationality: data.nationality || null,
    gender: data.gender || null,
    phone_number: data.phone_number || data.phone || null,
    status: data.status || 'pending_approval',
    created_by: data.created_by || 'AI',
    notes: data.notes || null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }

  // Simple create for now (update logic can be added later)
  const [id] = await db('profiles').insert(payload)
  return { id, ...payload }
}

/* ------------------------------------------------------------------ */
/* 3. saveFileToField  (stub – stores file path for now)              */
/* ------------------------------------------------------------------ */
export async function saveFileToField(profileId, fieldName, filePath) {
  // Minimal implementation – just log and return success
  logger.info(`[AI] saveFileToField profile=${profileId} field=${fieldName} file=${filePath}`)
  return { success: true }
}

/* ------------------------------------------------------------------ */
/* 4. generateAmharicResponse                                         */
/* ------------------------------------------------------------------ */
export async function generateAmharicResponse(context = {}) {
  if (!genAI) return 'መረጃው ተቀብሏል። እናመሰግናለን።'

  const model = genAI.getGenerativeModel({ model: MODEL })
  const prompt = `
You are a polite Ethiopian employment-agency assistant.
Reply in natural Amharic (Fidel script).
Context: ${JSON.stringify(context)}
Keep the reply short and professional.
`

  try {
    const result = await model.generateContent(prompt)
    return result.response.text().trim()
  } catch {
    return 'መረጃው ተቀብሏል። እናመሰግናለን።'
  }
}

/* ------------------------------------------------------------------ */
/* Folder watcher (Downloads)                                         */
/* ------------------------------------------------------------------ */
async function processFile(filePath) {
  const filename = path.basename(filePath)
  const ext = path.extname(filename).toLowerCase()
  const allowed = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf'
  }
  const mime = allowed[ext]
  if (!mime) return

  try {
    const stat = await fs.stat(filePath)
    if (stat.size > 2 * 1024 * 1024) {
      logger.warn(`[AI] File too large: ${filename}`)
      return
    }

    logger.info(`[AI] Processing ${filename} with ${MODEL} ...`)
    const buffer = await fs.readFile(filePath)
    const base64 = buffer.toString('base64')

    const extracted = await extractProfileData({
      imageBase64: base64,
      mimeType: mime
    })

    logger.info(`[AI] Extracted:`, extracted)

    const profile = await createOrUpdateProfile({
      ...extracted,
      created_by: 'AI-Folder-Watcher',
      notes: `Auto from ${filename} (confidence ${extracted.confidence || 'n/a'})`
    })

    logger.info(`[AI] Draft profile created → id ${profile.id}`)

    // Move to processed
    await fs.mkdir(PROCESSED_DIR, { recursive: true })
    const dest = path.join(PROCESSED_DIR, `${Date.now()}_${filename}`)
    await fs.rename(filePath, dest)

    // Notification
    try {
      await db('notifications').insert({
        type: 'ai_extraction',
        title: 'New draft profile from scan',
        body: `${extracted.full_name || 'Unknown'} – please review`,
        created_day: new Date().toISOString().slice(0, 10),
        created_at: new Date().toISOString()
      })
    } catch {}
  } catch (err) {
    logger.error(`[AI] Failed ${filename}: ${err.message}`)
  }
}

export function startFolderWatcher() {
  if (!API_KEY) {
    console.warn('[AI] Folder watcher NOT started – missing GEMINI_API_KEY')
    return
  }

  ensureDirs().then(() => {
    const watcher = chokidar.watch(SCANS_DIR, {
      ignored: [/(^|[\/\\])\../, path.join(SCANS_DIR, 'AdalKeep-Processed')],
      persistent: true,
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 }
    })

    watcher.on('add', (fp) => {
      if (fp.includes('AdalKeep-Processed')) return
      processFile(fp)
    })

    console.log(`[AI] Watching → ${SCANS_DIR}`)
    console.log(`[AI] Model   → ${MODEL}`)
  })
}

export default {
  extractProfileData,
  createOrUpdateProfile,
  saveFileToField,
  generateAmharicResponse,
  startFolderWatcher
}
