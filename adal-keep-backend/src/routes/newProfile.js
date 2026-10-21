/**
 * New profile, passport first. The page sends the passport; it is read at
 * once (JEV, then this PC's reader and Gemini side by side) and the form is
 * filled from it. The file waits here until the profile is saved, then goes
 * onto the profile's Passport field.
 */
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import multer from 'multer'
import { analyzeWithMineru } from '../services/mineruClassifier.js'

const router = express.Router()
const TMP = path.join(os.tmpdir(), 'adal-new-profile')
fs.mkdirSync(TMP, { recursive: true })
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${path.extname(file.originalname).toLowerCase()}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
})

// Waiting passports older than a day were never saved: remove them.
function sweep() {
  for (const f of fs.readdirSync(TMP)) {
    const p = path.join(TMP, f)
    try { if (Date.now() - fs.statSync(p).mtimeMs > 86400000) fs.unlinkSync(p) } catch {}
  }
}

const tmpPath = (name) => {
  const base = path.basename(String(name || ''))
  return base && fs.existsSync(path.join(TMP, base)) ? path.join(TMP, base) : null
}

router.post('/new-profile/read', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' })
  sweep()
  const db = req.app.locals.db
  const t0 = Date.now()
  try {
    const r = await analyzeWithMineru(req.file.path, { db })
    const f = r.fields || {}
    const verified = r.doc_type === 'Passport' && (r.confidence || 0) >= 0.9
    // Already a profile with this passport number? The page offers to open it.
    const existing = f.passport_number
      ? await db('profiles').where('passport_number', String(f.passport_number).toUpperCase()).first()
      : null
    res.json({
      upload: path.basename(req.file.path),
      filename: req.file.originalname,
      doc_type: r.doc_type,
      confidence: r.confidence,
      verified,
      source: r.source || null,
      ms: Date.now() - t0,
      fields: {
        full_name: f.full_name || [f.given_names, f.surname].filter(Boolean).join(' ') || '',
        first_name: f.first_name || (f.given_names || '').split(' ')[0] || '',
        middle_name: f.middle_name || (f.given_names || '').split(' ').slice(1).join(' ') || '',
        last_name: f.last_name || f.surname || '',
        passport_number: f.passport_number || '',
        date_of_birth: f.date_of_birth || '',
        gender: f.sex || f.gender || '',
        place_of_birth: f.place_of_birth || '',
        passport_issue_date: f.date_of_issue || f.passport_issue_date || '',
        passport_expiry_date: f.date_of_expiry || f.passport_expiry_date || '',
        nationality: f.nationality || '',
      },
      existing: existing ? { id: existing.id, full_name: existing.full_name } : null,
    })
  } catch (e) {
    res.json({ upload: path.basename(req.file.path), filename: req.file.originalname, error: e.message, ms: Date.now() - t0 })
  }
})

// The profile is saved: the waiting passport goes onto it and is checked.
router.post('/new-profile/attach', async (req, res) => {
  const db = req.app.locals.db
  const { upload: name, profileId, filename } = req.body || {}
  const file = tmpPath(name)
  if (!file || !profileId) return res.status(400).json({ error: 'Nothing to attach' })
  try {
    const { attachFileToProfile } = await import('../services/profileFiles.js')
    await attachFileToProfile(Number(profileId), 'Passport', file, filename || path.basename(file))
    fs.unlink(file, () => {})
    let verification = null
    try {
      const { runPassportVerification } = await import('../services/verification.js')
      verification = await runPassportVerification(Number(profileId), { handle: db })
    } catch {}
    res.json({ ok: true, ticks: verification?.ticks_count ?? null })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router
