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
import { scan, FIRST_MS } from '../services/passportScan.js'

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

// The place of birth, region and date of issue of a passport just read: they
// come a few seconds after its bottom lines (one small Gemini question), so the
// form is filled at once and these three follow (GET /new-profile/place/:upload).
const PLACES = new Map()   // upload name -> { at, fields: Promise }
const placeFields = (f = {}) => ({
  place_of_birth: f.place_of_birth || '',
  region: f.region || '',
  passport_issue_date: f.date_of_issue || f.passport_issue_date || '',
})

/** The reader is started before the passport comes (the new-profile page opens). */
router.post('/new-profile/warm', async (req, res) => {
  const { warmMrzReader } = await import('../services/quickMrz.js')
  warmMrzReader().catch(() => {})
  import('../services/passportVisual.js').then(m => m.warmVisualReader()).catch(() => {})
  res.json({ ok: true })
})

router.get('/new-profile/place/:upload', async (req, res) => {
  const hit = PLACES.get(path.basename(String(req.params.upload || '')))
  if (!hit) return res.json({ fields: null })
  const got = await Promise.race([hit.fields, new Promise(r => setTimeout(() => r(null), 9000))])
  res.json({ fields: got ? placeFields(got) : null })
})

// A scan the page is still waiting for (it asked for more than FIRST_MS): upload name ->
// { at, step, done, payload }. The page asks GET /new-profile/result/:upload every second.
const JOBS = new Map()
const STEPS = { waiting: 'Waiting for the scan before it', reading: 'Reading the passport lines', checking: 'Checking the numbers', 'asking the cloud readers': 'Not clear at first — reading the whole page', done: 'Done' }

/** What the page gets for a finished scan. */
async function payloadOf(db, file, r, t0) {
  let f = r.fields || {}
  // Already known (nothing to ask): in this answer. Else it follows.
  let placePending = false
  if (r.placeLater) {
    const now = await Promise.race([r.placeLater, new Promise(res2 => setImmediate(() => res2(null)))])
    if (now) f = { ...f, ...now }
    else { placePending = true; PLACES.set(path.basename(file.path), { at: Date.now(), fields: r.placeLater }) }
  }
  const verified = r.doc_type === 'Passport' && (r.confidence || 0) >= 0.9
  // Already a profile with this passport number? The page offers to open it.
  const existing = f.passport_number
    ? await db('profiles').where('passport_number', String(f.passport_number).toUpperCase()).first()
    : null
  return {
    upload: path.basename(file.path),
    filename: file.originalname,
    doc_type: r.doc_type,
    confidence: r.confidence,
    verified,
    source: r.source || null,
    ms: Date.now() - t0,
    place_pending: placePending,
    fields: {
      full_name: f.full_name || [f.given_names, f.surname].filter(Boolean).join(' ') || '',
      first_name: f.first_name || (f.given_names || '').split(' ')[0] || '',
      middle_name: f.middle_name || (f.given_names || '').split(' ').slice(1).join(' ') || '',
      last_name: f.last_name || f.surname || '',
      passport_number: f.passport_number || '',
      date_of_birth: f.date_of_birth || '',
      gender: f.sex || f.gender || '',
      place_of_birth: f.place_of_birth || '',
      region: f.region || '',
      passport_issue_date: f.date_of_issue || f.passport_issue_date || '',
      passport_expiry_date: f.date_of_expiry || f.passport_expiry_date || '',
      nationality: f.nationality || '',
    },
    existing: existing ? { id: existing.id, full_name: existing.full_name } : null,
  }
}

async function failureOf(file, e, t0) {
  // Say which reader failed and why (also in server.log for Adal).
  const { isGeminiConfigured, lastGeminiError } = await import('../services/geminiClassifier.js')
  const { jevReady } = await import('../services/jevClassifier.js')
  const why = [
    e.message,
    isGeminiConfigured() ? (lastGeminiError ? `Gemini: ${lastGeminiError}` : null) : 'Gemini has no key on this PC',
    jevReady() ? null : 'JEV has no key on this PC',
  ].filter(Boolean).join(' · ')
  console.error(`[new-profile] passport not read (${file.originalname}, ${file.size} bytes): ${why}\n${e.stack || ''}`)
  // The page shows plain words; the reasons (readers, keys) stay in the log above.
  return { upload: path.basename(file.path), filename: file.originalname, error: 'the numbers at the bottom of the page could not be read', ms: Date.now() - t0 }
}

/**
 * The scan answers within FIRST_MS when its bottom lines verify (the usual case). A scan
 * that needs the slower readers answers { pending, step } at once instead of holding the
 * request for a minute; the page then asks /new-profile/result/:upload.
 */
router.post('/new-profile/read', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' })
  sweep()
  for (const [k, v] of PLACES) if (Date.now() - v.at > 120000) PLACES.delete(k)
  for (const [k, v] of JOBS) if (Date.now() - v.at > 600000) JOBS.delete(k)
  const db = req.app.locals.db
  const t0 = Date.now()
  const key = path.basename(req.file.path)
  const job = { at: t0, step: 'waiting', done: false, payload: null }
  JOBS.set(key, job)
  const work = scan(req.file.path, { db, onStep: (s) => { job.step = s } })
    .then(r => payloadOf(db, req.file, r, t0))
    .catch(e => failureOf(req.file, e, t0))
    .then(p => { job.payload = p; job.done = true; return p })
  const early = await Promise.race([work, new Promise(r => setTimeout(() => r(null), Number(process.env.SCAN_FIRST_MS || FIRST_MS)))])
  if (early) { JOBS.delete(key); return res.json(early) }
  res.json({ upload: key, filename: req.file.originalname, pending: true, step: job.step, step_text: STEPS[job.step] || '', ms: Date.now() - t0 })
})

router.get('/new-profile/result/:upload', async (req, res) => {
  const key = path.basename(String(req.params.upload || ''))
  const job = JOBS.get(key)
  if (!job) return res.status(404).json({ error: 'This scan is no longer here — scan the passport again.' })
  if (!job.done) return res.json({ upload: key, pending: true, step: job.step, step_text: STEPS[job.step] || '', ms: Date.now() - job.at })
  JOBS.delete(key)
  res.json(job.payload)
})

// A passport picture that also holds her photo and her standing photo (how most
// agencies send them): JEV finds them and they go into Photo and Full Body Photo,
// and the passport part stays in Passport (services/placement.js).
function splitLater(db, profileId, fileId) {
  if (!fileId) return
  db('files').where('id', fileId).first().then(row => row && import('../services/placement.js').then(p => p.checkPlacement(db, profileId, 'Passport', row, { review: true })))
    .catch(e => console.warn('[placement]', e.message))
}

// The profile is saved: the waiting passport goes onto it and is checked.
router.post('/new-profile/attach', async (req, res) => {
  const db = req.app.locals.db
  const { upload: name, profileId, filename } = req.body || {}
  const file = tmpPath(name)
  if (!file || !profileId) return res.status(400).json({ error: 'Nothing to attach' })
  try {
    const { attachFileToProfile } = await import('../services/profileFiles.js')
    const att = await attachFileToProfile(Number(profileId), 'Passport', file, filename || path.basename(file))
    fs.unlink(file, () => {})
    // Attached: the page goes on; the passport is checked behind.
    res.json({ ok: true })
    import('../services/verification.js').then(v => v.runPassportVerification(Number(profileId), { handle: db })).catch(() => {})
    splitLater(db, Number(profileId), att?.fileId)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router

/**
 * The profile and her passport in one go (FormData: file + profile as JSON).
 * Made for Adal Admin and the phones while the office PC does not answer: the
 * request waits online and this PC runs it when it is back — nobody at the
 * agency has to do anything. Sent twice (a replay), it never makes two
 * profiles: a profile with the same passport number gets the passport instead.
 */
router.post('/new-profile/with-passport', upload.single('file'), async (req, res) => {
  const db = req.app.locals.db
  try {
    let profile = {}
    try { profile = JSON.parse(req.body?.profile || '{}') } catch {}
    const pn = String(profile.passport_number || '').toUpperCase().replace(/\s/g, '')
    let id = pn ? (await db('profiles').where('passport_number', pn).first())?.id : null
    if (!id) {
      // The usual "create profile" of this PC (its checks and robots), asked here.
      const fwd = Object.fromEntries(['authorization', 'cookie', 'x-adal-cloud', 'x-adal-who'].filter(h => req.headers[h]).map(h => [h, req.headers[h]]))
      const r = await fetch(`http://127.0.0.1:${process.env.PORT || 4000}/api/profiles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...fwd }, body: JSON.stringify(profile), signal: AbortSignal.timeout(60000),
      })
      const made = await r.json().catch(() => ({}))
      if (!r.ok) return res.status(r.status).json(made)
      id = made.id
    }
    // The same passport file already on her (the request came twice): not again.
    const twice = req.file && id && await db('files').join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
      .where('profile_fields.profile_id', id).where('profile_fields.name', 'Passport').where('files.size', req.file.size).first().catch(() => null)
    if (twice) fs.unlink(req.file.path, () => {})
    if (req.file && id && !twice) {
      const { attachFileToProfile } = await import('../services/profileFiles.js')
      const att = await attachFileToProfile(Number(id), 'Passport', req.file.path, req.file.originalname || 'passport.jpg')
      splitLater(db, Number(id), att?.fileId)
      fs.unlink(req.file.path, () => {})
      import('../services/verification.js').then(v => v.runPassportVerification(Number(id), { handle: db })).catch(() => {})
    }
    res.status(201).json({ ok: true, id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})
