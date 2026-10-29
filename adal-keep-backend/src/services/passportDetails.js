/**
 * The printed details a passport's machine-readable lines do not carry —
 * place of birth and date of issue. A passport settled from those lines alone
 * (JEV, or this PC's own reading) left them empty; this reads them after the
 * passport is filed and fills only what the profile does not have yet:
 *   1. this PC's own reading of the printed text (free)
 *   2. Gemini's quick model, when a key is set
 */
import fs from 'fs'
import path from 'path'

const IMAGE = /\.(jpe?g|png|webp)$/i
const BLOCK = /^(PLACE|BIRTH|OF|DATE|ISSUE|ISSUED|EXPIRY|AUTHORITY|SEX|NATIONALITY|PASSPORT|FEDERAL|REPUBLIC|ETHIOPIAN|M|F)$/

function cleanPlace(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z\s'-]/g, ' ').replace(/\s+/g, ' ').trim()
  if (s.length < 2 || s.length > 40) return ''
  if (s.split(' ').every(w => BLOCK.test(w))) return ''
  return s
}
/** An issue date that makes sense: after birth, before expiry and today. */
function cleanIssue(v, p) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!m) return ''
  const d = m[0], today = new Date().toISOString().slice(0, 10)
  if (d > today) return ''
  if (p.date_of_birth && d <= String(p.date_of_birth).slice(0, 10)) return ''
  if (p.passport_expiry_date && /^\d{4}-\d{2}-\d{2}/.test(p.passport_expiry_date) && d >= String(p.passport_expiry_date).slice(0, 10)) return ''
  return d
}

const missing = (p) => ({ place: !String(p.place_of_birth || '').trim(), issue: !String(p.passport_issue_date || '').trim() })

export async function fillPassportDetails(db, profileId, imagePath, log = console.log) {
  let p = await db('profiles').where('id', profileId).first()
  if (!p || !imagePath || !fs.existsSync(imagePath)) return {}
  let need = missing(p)
  if (!need.place && !need.issue) return {}
  const got = {}
  const take = (f, src) => {
    if (need.place && !got.place_of_birth) { const v = cleanPlace(f.place_of_birth); if (v) got.place_of_birth = v }
    if (need.issue && !got.passport_issue_date) { const v = cleanIssue(f.date_of_issue || f.passport_issue_date, p); if (v) got.passport_issue_date = v }
    if (Object.keys(got).length) log(`[passport details] profile #${profileId}: ${Object.entries(got).map(([k, v]) => `${k}=${v}`).join(', ')} (${src})`)
  }
  const done = () => (!need.place || got.place_of_birth) && (!need.issue || got.passport_issue_date)

  // 1. This PC's own reading.
  if (IMAGE.test(imagePath)) {
    try {
      const { extractPassport, extractVisualFields } = await import('./passportOcr.js')
      const ocr = await extractPassport(imagePath)
      take(extractVisualFields(ocr?.visualText || ''), 'this PC')
    } catch {}
  }
  // 2. Gemini's quick model.
  if (!done()) {
    try {
      const { classifyWithGemini, isGeminiConfigured } = await import('./geminiClassifier.js')
      if (isGeminiConfigured()) {
        const r = await classifyWithGemini({ filePath: imagePath, filename: path.basename(imagePath), models: [process.env.GEMINI_QUICK_MODEL || 'gemini-3.5-flash-lite'] })
        take(r?.fields || {}, 'Gemini')
      }
    } catch (e) { log(`[passport details] profile #${profileId}: Gemini did not answer (${e.message})`) }
  }
  if (!Object.keys(got).length) return {}
  // Only what is still empty (a person may have typed it meanwhile).
  p = await db('profiles').where('id', profileId).first()
  need = missing(p)
  const upd = {}
  if (need.place && got.place_of_birth) upd.place_of_birth = got.place_of_birth
  if (need.issue && got.passport_issue_date) upd.passport_issue_date = got.passport_issue_date
  if (Object.keys(upd).length) await db('profiles').where('id', profileId).update({ ...upd, updated_at: new Date().toISOString() })
  return upd
}

/** The passport picture on a profile (its image twin first). */
export async function passportImageOf(db, profileId) {
  const { SAFE_STORAGE_DIR } = await import('./docPipeline.js')
  const rows = await db('files')
    .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', profileId)
    .whereRaw('lower(profile_fields.name) = ?', ['passport'])
    .orderBy('files.id', 'desc')
    .select('files.path', 'files.mimetype')
  const root = path.join(path.dirname(new URL(import.meta.url).pathname), '../..')
  const full = (r) => {
    if (path.isAbsolute(r.path)) return r.path
    const inSafe = path.join(SAFE_STORAGE_DIR || '', r.path)
    return fs.existsSync(inSafe) ? inSafe : path.join(root, r.path)   // older ones: uploads/<profile>/…
  }
  const img = rows.find(r => /^image\//.test(r.mimetype || '') && fs.existsSync(full(r)))
  const any = img || rows.find(r => fs.existsSync(full(r)))
  return any ? full(any) : null
}

/** Once: profiles with a passport but no place of birth / issue date. */
export async function backfillPassportDetails(db, log = console.log) {
  const rows = await db('profiles')
    .whereNotNull('passport_number').where('passport_number', '<>', '')
    .where(q => q.whereNull('place_of_birth').orWhere('place_of_birth', '').orWhereNull('passport_issue_date').orWhere('passport_issue_date', ''))
    .select('id')
  for (const { id } of rows) {
    try {
      const img = await passportImageOf(db, id)
      if (img) await fillPassportDetails(db, id, img, log)
    } catch (e) { log(`[passport details] profile #${id}: ${e.message}`) }
  }
  return rows.length
}
