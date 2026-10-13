import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { runPipeline, startWatcher } from './docPipeline.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WATCH_DIR = process.env.WATCH_DIR ||
  (process.platform === 'win32' ? 'C:\\AdalKeep\\inbox' : '/home/abduhabibi/Downloads')

// Offline analyzer: Tesseract + filename hints. Lower accuracy, no internet.
async function offlineAnalyze(imagePath, filename, mimeType) {
  const Tesseract = (await import('tesseract.js')).default
  let text = ''
  try {
    const r = await Tesseract.recognize(imagePath, 'eng', {
      langPath: path.join(__dirname, '../..'),
      cachePath: path.join(__dirname, '../../data/tessdata'),
    })
    text = r.data.text || ''
  } catch (e) { console.warn('[offline] OCR failed:', e.message) }

  const lower = filename.toLowerCase()
  const lowerText = text.toLowerCase()
  const HINTS = {
    'Passport': ['passport', 'pasport'],
    'Contract': ['contract', 'agreement'],
    'CV': ['cv', 'resume', 'curriculum'],
    'Government ID': ['national id', 'kebele'],
    'Insurance': ['insurance', 'policy'],
    'Medical Report': ['medical', 'health', 'exam'],
    'Visa': ['visa', 'entry permit'],
    'Police Clearance': ['police', 'clearance', 'good conduct'],
    'COC': ['coc', 'competence'],
  }
  let doc_type = 'other'
  for (const [k, kws] of Object.entries(HINTS)) {
    if (kws.some(w => lower.includes(w)) || kws.some(w => lowerText.includes(w))) { doc_type = k; break }
  }

  const fields = {}
  // Cheap heuristics only — offline is a fallback
  const pno = text.match(/\b(?:EP|E0|EQ|ED)\s*\d{5,}\b/i)
  if (pno) fields.passport_number = pno[0].replace(/\s/g, '').toUpperCase()
  const dob = text.match(/\b(\d{1,2})[\s\/\-.](\d{1,2})[\s\/\-.](\d{4})\b/)
  if (dob) {
    let [,a,b,y] = dob
    const d = parseInt(a,10) > 12 ? a : b
    const m = parseInt(a,10) > 12 ? b : a
    fields.date_of_birth = `${y}-${String(parseInt(m,10)).padStart(2,'0')}-${String(parseInt(d,10)).padStart(2,'0')}`
  }

  return { doc_type, confidence: doc_type === 'other' ? 0 : 0.55, fields }
}

export async function processFile(filePath, db) {
  return runPipeline(filePath, db, offlineAnalyze, '[OFFLINE]')
}

export function startOfflineProcessor(db) {
  console.log(`[OFFLINE] tesseract fallback watching ${WATCH_DIR}`)
  startWatcher(WATCH_DIR, db, processFile, '[OFFLINE]')
}

export const startFolderWatcher = startOfflineProcessor
