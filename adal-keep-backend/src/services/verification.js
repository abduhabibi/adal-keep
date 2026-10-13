/**
 * verification.js — the "3 green ticks" gate that stands between an uploaded
 * passport and the police-clearance automation.
 *
 * The three ticks
 * ---------------
 *   1. READ       OCR (PDF text layer, or local Tesseract fallback) actually
 *                 returned text for the passport file.
 *   2. EXTRACTED  Every bio-page field the LMIS form needs is present:
 *                 full name, passport number, date of birth, sex,
 *                 nationality and expiry date.
 *   3. VERIFIED   The MRZ check digits validate. This is the tick that
 *                 matters: TD3 passports carry weighted-modulus check digits
 *                 over the passport number, the date of birth and the date of
 *                 expiry, so a *verified* tick proves the OCR read real
 *                 glyphs and did not hallucinate a name or a number.
 *
 * Why a gate at all
 * -----------------
 * `stepUploadDocuments()` commits to LMIS while it runs. Starting it with a
 * mis-read passport number produces a certificate filed against the wrong
 * person — the most expensive failure this system can have. So:
 * `police_certificate` will not start unless all three ticks are green.
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import db from '../config/database.js'
import logger from '../utils/logger.js'
import { parseTD3 } from './mrz.js'
import { findMrz } from './mineruClassifier.js'
import { parseDocumentToMarkdown, isMineruConfigured } from './mineruClient.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// Files are stored under SafeStorage/<basename>; the DB keeps a relative
// path. This mirrors worker.js's resolveFilePaths() lookup order.
const SAFE_STORAGE_DIR = path.join(__dirname, '../../data/SafeStorage')

/**
 * Turn whatever the files table has in `path` into a real, on-disk path.
 * Falls back through the same candidates worker.js uses so the two modules
 * agree on where a file is.
 */
function resolveStoredPath(dbPath) {
  if (!dbPath) return null
  const base = path.basename(dbPath)
  const candidates = [
    path.join(SAFE_STORAGE_DIR, base),
    dbPath,
    path.join(process.cwd(), dbPath),
  ]
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch {}
  }
  return candidates[0] // report the "expected" location if nothing exists
}

/** Documents the police-clearance workflow needs, per routes/automations.js. */
export const POLICE_WORKFLOW_DOCS = ['Photo', 'Passport', 'Slip']

/** The three ticks, in the order they light up on screen. */
export const TICKS = [
  {
    key: 'read',
    label: 'Document read',
    hint: 'OCR returned text for the passport file.',
  },
  {
    key: 'extracted',
    label: 'Bio data extracted',
    hint: 'Name, passport no., birth date, sex, nationality and expiry all found.',
  },
  {
    key: 'verified',
    label: 'MRZ checksums valid',
    hint: 'The passport’s own check digits confirm the numbers were read correctly.',
  },
]

/** Bio-page fields that must be present for tick 2. */
const REQUIRED_MRZ_FIELDS = [
  'surname',
  'given_names',
  'passport_number',
  'date_of_birth',
  'sex',
  'nationality_code',
  'date_of_expiry',
]

/** Create the verification table + the profile columns the gates read. */
export async function ensureVerificationSchema(handle = db) {
  const has = await handle.schema.hasTable('document_verifications')
  if (!has) {
    await handle.schema.createTable('document_verifications', (t) => {
      t.increments('id').primary()
      t.integer('profile_id').notNullable()
      t.string('field_name')
      t.string('doc_type')
      t.string('source')            // tesseract | pdf-text | none
      t.integer('ticks_count').defaultTo(0)
      t.boolean('all_green').defaultTo(false)
      t.text('ticks_json')
      t.text('fields_json')
      t.text('problems_json')
      t.timestamps(true, true)
    })
  }

  const cols = await handle('profiles').columnInfo().catch(() => ({}))
  const add = async (name, fn) => {
    if (cols[name] === undefined) await handle.schema.table('profiles', fn)
  }
  await add('passport_ticks', (t) => t.integer('passport_ticks').defaultTo(0))
  await add('verified_at', (t) => t.string('verified_at'))
  await add('mrz_source', (t) => t.string('mrz_source'))
  return true
}

/**
 * Newest file attached to a named profile field.
 * Returns the RESOLVED absolute path (see resolveStoredPath) so callers can
 * feed it straight to fs.readFile / the OCR readers.
 *
 * @returns {Promise<{fileId:number, path:string, originalPath:string, name:string}|null>}
 */
export async function findProfileFieldFile(profileId, fieldName, handle = db) {
  const row = await handle('files')
    .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', profileId)
    .andWhere('profile_fields.name', fieldName)
    .orderBy('files.id', 'desc')
    .select('files.id as fileId', 'files.path as path', 'files.original_name as name')
    .first()
  if (!row) return null
  return {
    ...row,
    originalPath: row.path,
    path: resolveStoredPath(row.path),
  }
}

/** Which of `POLICE_WORKFLOW_DOCS` are attached (with a real, non-empty file). */
export async function checkRequiredDocuments(profileId, handle = db) {
  const out = []
  for (const name of POLICE_WORKFLOW_DOCS) {
    const row = await findProfileFieldFile(profileId, name, handle)
    let ok = false
    let size = 0
    if (row?.path && fs.existsSync(row.path)) {
      try { size = fs.statSync(row.path).size } catch {}
      ok = size > 0
    }
    out.push({
      name,
      present: !!row,
      ok,
      path: row?.path || null,
      rawPath: row?.originalPath || null,
      size,
    })
  }
  return out
}

/**
 * Pull the raw text of a passport page, cheapest reliable source first.
 *
 *   PDF text layer   (digital passports exported as PDF)
 *      ↓ not a PDF / no text
 *   Tesseract OCR    (always available, fully offline)
 *
 * @returns {Promise<{source:string, text:string, mrzText:string, visualText:string}>}
 */
async function readPassportText(filePath, originalPath, markdown = null) {
  const target = originalPath && fs.existsSync(originalPath) ? originalPath : filePath
  const isPdf = /\.pdf$/i.test(target)

  // --- 0. MinerU (primary) — also reused when the ingest already ran it ----
  const md = markdown || (isMineruConfigured() ? await parseDocumentToMarkdown(target).catch(e => {
    logger.warn(`[verification] MinerU failed: ${e.message}`)
    return null
  }) : null)
  if (md && md.trim().length >= 10) {
    const found = findMrz(md)
    const mrzText = found ? `${found.line1}\n${found.line2}` : ''
    return { source: 'mineru', text: md, mrzText, visualText: md }
  }

  // --- 1. PDF text layer ----------------------------------------------
  if (isPdf) {
    try {
      const mod = await import('pdf-parse')
      const parse = mod.default || mod.pdf || mod
      const buf = fs.readFileSync(target)
      const res = await parse(buf)
      const text = String(res?.text || '')
      if (text.trim().length >= 10) {
        return { source: 'pdf-text', text, mrzText: text, visualText: text }
      }
    } catch (e) {
      logger.warn(`[verification] pdf text layer failed: ${e.message}`)
    }
  }

  // --- 2. Tesseract ---------------------------------------------------
  try {
    const { extractPassport } = await import('./passportOcr.js')
    const r = await extractPassport(target)
    const mrzText = String(r?.mrzText || '')
    const visualText = String(r?.visualText || '')
    return { source: 'tesseract', text: `${visualText}\n${mrzText}`, mrzText, visualText }
  } catch (e) {
    logger.error(`[verification] tesseract failed: ${e.message}`)
    return { source: 'none', text: '', mrzText: '', visualText: '' }
  }
}

/** First of the given strings that yields a parseable TD3 MRZ. */
function firstMrz(...candidates) {
  for (const c of candidates) {
    const m = parseTD3(String(c || ''))
    if (m) return m
  }
  return null
}

/**
 * Turn a parsed MRZ into the three ticks. Pure function — unit-testable
 * without any OCR, any network or any database.
 */
export function computeTicks(input) {
  const mrz = input?.mrz || null
  const text = String(input?.text || '')

  const read = !!mrz || text.replace(/\s/g, '').length >= 20

  const missing_fields = []
  if (mrz) {
    for (const f of REQUIRED_MRZ_FIELDS) {
      const v = mrz[f]
      if (v === null || v === undefined || String(v).trim() === '') missing_fields.push(f)
    }
  } else {
    missing_fields.push(...REQUIRED_MRZ_FIELDS)
  }
  const extracted = !!mrz && missing_fields.length === 0

  const verified = !!mrz &&
    mrz.passport_number_verified === true &&
    mrz.date_of_birth_verified === true &&
    mrz.date_of_expiry_verified === true

  const values = { read, extracted, verified }
  const ticks = TICKS.map((t) => ({ ...t, ok: !!values[t.key] }))
  const count = ticks.filter((t) => t.ok).length

  return {
    ticks,
    ticks_count: count,
    all_green: count === TICKS.length,
    read,
    extracted,
    verified,
    missing_fields,
    overall_verified: mrz ? mrz.overall_verified === true : false,
  }
}

function mrzFields(mrz) {
  if (!mrz) return null
  return {
    doc_type: 'passport',
    surname: mrz.surname || '',
    given_names: mrz.given_names || '',
    full_name: [mrz.given_names, mrz.surname].filter(Boolean).join(' ').trim(),
    passport_number: mrz.passport_number || '',
    date_of_birth: mrz.date_of_birth || null,
    sex: mrz.sex || null,
    nationality_code: mrz.nationality_code || '',
    issuing_country: mrz.issuing_country || '',
    date_of_expiry: mrz.date_of_expiry || null,
    personal_number: mrz.personal_number || null,
    checks: {
      passport_number: mrz.passport_number_verified === true,
      date_of_birth: mrz.date_of_birth_verified === true,
      date_of_expiry: mrz.date_of_expiry_verified === true,
      composite: mrz.overall_verified === true,
    },
  }
}

function blockersFor(ticks, docs, laborId) {
  const out = []
  for (const d of docs) if (!d.ok) out.push(`${d.name} file missing or empty`)
  if (!laborId || !String(laborId).trim()) out.push('Labor ID is not set on the profile')
  for (const t of ticks.ticks) if (!t.ok) out.push(`${t.label} — not green yet`)
  return out
}

/**
 * Read the profile's newest passport file and light up the three ticks.
 * Safe to call repeatedly — it is the "Re-check" button.
 */
export async function runPassportVerification(profileId, opts = {}) {
  const handle = opts.handle || db
  await ensureVerificationSchema(handle)

  const profile = await handle('profiles').where('id', profileId).first()
  if (!profile) throw new Error(`Profile ${profileId} not found`)

  const docs = await checkRequiredDocuments(profileId, handle)
  const passportDoc = docs.find((d) => d.name === 'Passport')
  const passportFile = passportDoc?.ok ? passportDoc : null

  let mrz = null
  let read = { source: 'none', text: '', mrzText: '', visualText: '' }
  const problems = []

  if (!passportFile) {
    problems.push('No Passport file attached to this profile yet.')
  } else {
    read = await readPassportText(passportFile.path, passportFile.path, opts.markdown || null)
    mrz = firstMrz(read.mrzText, read.text, read.visualText)
    if (!mrz) {
      problems.push(
        read.source === 'none'
          ? 'The passport file could not be read at all (unreadable or unsupported format).'
          : 'No machine-readable zone (MRZ) found — photograph the passport page straight-on, ' +
            'include both MRZ lines fully, and re-upload.'
      )
    } else {
      if (!mrz.passport_number_verified) problems.push('Passport-number check digit does not match.')
      if (!mrz.date_of_birth_verified) problems.push('Date-of-birth check digit does not match.')
      if (!mrz.date_of_expiry_verified) problems.push('Expiry-date check digit does not match.')
    }
  }

  const result = computeTicks({ mrz, text: read.text, visualText: read.visualText })
  const fields = mrzFields(mrz) || { doc_type: 'passport', source: read.source }
  const blockers = blockersFor(result, docs, profile.labor_id)

  const now = new Date().toISOString()
  await handle('document_verifications').insert({
    profile_id: profileId,
    field_name: 'Passport',
    doc_type: 'passport',
    source: read.source,
    ticks_count: result.ticks_count,
    all_green: result.all_green,
    ticks_json: JSON.stringify(result.ticks),
    fields_json: JSON.stringify(fields),
    problems_json: JSON.stringify(problems),
    created_at: now,
    updated_at: now,
  })

  const patch = {
    passport_ticks: result.ticks_count,
    verified_at: result.all_green ? now : null,
    mrz_source: read.source,
    updated_at: now,
  }
  if (result.all_green && fields.full_name) {
    if (!String(profile.full_name || '').trim()) patch.full_name = fields.full_name
    if (!String(profile.passport_number || '').trim()) patch.passport_number = fields.passport_number
  }
  const profileCols = await handle('profiles').columnInfo().catch(() => ({}))
  for (const k of Object.keys(patch)) if (profileCols[k] === undefined) delete patch[k]
  await handle('profiles').where('id', profileId).update(patch)

  logger.info(
    `[verification] profile ${profileId}: ${result.ticks_count}/3 ticks ` +
    `(source=${read.source}, mrz=${!!mrz})`
  )

  return {
    profile_id: profileId,
    source: read.source,
    passport: {
      present: !!passportFile,
      file: passportFile?.path || null,
      filename: passportFile ? path.basename(passportFile.path) : null,
      mrz_found: !!mrz,
      mrz_line1: mrz?.mrz_line1 || null,
      mrz_line2: mrz?.mrz_line2 || null,
    },
    fields,
    problems,
    documents: docs,
    ...result,
    blockers,
  }
}

/** Cached read — never runs OCR. Used by the polling frontend panel. */
export async function getProfileVerification(profileId, opts = {}) {
  const handle = opts.handle || db
  await ensureVerificationSchema(handle)

  const profile = await handle('profiles').where('id', profileId).first()
  const docs = await checkRequiredDocuments(profileId, handle)

  const last = await handle('document_verifications')
    .where('profile_id', profileId)
    .orderBy('id', 'desc')
    .first()

  const parsed = (raw, fallback) => {
    try { return JSON.parse(raw) ?? fallback } catch { return fallback }
  }
  const cachedTicks = parsed(last?.ticks_json, [])
  const fields = parsed(last?.fields_json, null)
  const problems = parsed(last?.problems_json, [])

  const ticks = TICKS.map((t) => {
    const hit = Array.isArray(cachedTicks) ? cachedTicks.find((c) => c.key === t.key) : null
    return { ...t, ok: !!(hit && hit.ok) }
  })
  const ticks_count = ticks.filter((t) => t.ok).length

  const shaped = {
    ticks,
    ticks_count,
    all_green: ticks_count === TICKS.length,
    read: ticks[0].ok,
    extracted: ticks[1].ok,
    verified: ticks[2].ok,
    missing_fields: [],
    overall_verified: fields?.checks?.composite === true,
  }

  return {
    profile_id: Number(profileId),
    checked_at: last?.updated_at || last?.created_at || null,
    source: last?.source || null,
    fields,
    problems,
    documents: docs,
    ...shaped,
    blockers: blockersFor(shaped, docs, profile?.labor_id),
  }
}

// Do not re-run OCR more often than this for a single profile. Prevents a
// bad passport from looping OCR on every poll of the gate.
const AUTO_VERIFY_THROTTLE_MS = 60_000

/**
 * Cheap gate for the automation pipeline.
 *
 * Reads the cached `profiles.passport_ticks`. If all required files are
 * present but the cached value is short, it runs verification ONCE (subject
 * to a throttle) and re-reads the fresh tick count. This is what makes the
 * workflow startable from a fresh upload — the operator is not required to
 * have clicked "Re-check" beforehand.
 *
 * Pass `{ autoVerify: false }` to restore the old read-only behaviour.
 *
 * @returns {Promise<{ok:boolean, blockers:string[], ticks:number}>}
 */
export async function assertPoliceReady(profileId, opts = {}) {
  const handle = opts.handle || db
  const autoVerify = opts.autoVerify !== false

  const profile = await handle('profiles').where('id', profileId).first()
  if (!profile) return { ok: false, blockers: ['Profile not found'], ticks: 0 }

  const docs = await checkRequiredDocuments(profileId, handle)
  const blockers = []
  for (const d of docs) if (!d.ok) blockers.push(`${d.name} file missing or empty`)
  if (!profile.labor_id || !String(profile.labor_id).trim()) {
    blockers.push('Labor ID is not set on the profile')
  }

  let ticks = Number(profile.passport_ticks || 0)

  // Auto-verify path: only when every required file is actually present,
  // the cached tick count is short, and we haven't run recently.
  const filesOk = docs.every((d) => d.ok)
  if (autoVerify && filesOk && ticks < TICKS.length) {
    const last = await handle('document_verifications')
      .where('profile_id', profileId)
      .orderBy('id', 'desc')
      .first()
      .catch(() => null)
    const lastAt = last?.created_at ? Date.parse(last.created_at) : 0
    const elapsed = Date.now() - (Number.isFinite(lastAt) ? lastAt : 0)

    if (elapsed > AUTO_VERIFY_THROTTLE_MS) {
      try {
        const fresh = await runPassportVerification(profileId, { handle })
        ticks = Number(fresh.ticks_count || 0)
        // Surface the per-tick reasons so the operator knows which one is red.
        for (const t of fresh.ticks || []) {
          if (!t.ok && !blockers.some((b) => b.startsWith(t.label))) {
            blockers.push(`${t.label} — not green yet`)
          }
        }
      } catch (e) {
        logger.warn(`[verification] auto-run failed for profile ${profileId}: ${e.message}`)
      }
    }
  }

  if (ticks < TICKS.length && !blockers.some((b) => b.includes('green ticks'))) {
    blockers.push(`Passport verification is ${ticks}/3 green ticks — re-check the passport`)
  }
  return { ok: blockers.length === 0, blockers, ticks }
}

export default {
  TICKS,
  POLICE_WORKFLOW_DOCS,
  ensureVerificationSchema,
  computeTicks,
  runPassportVerification,
  getProfileVerification,
  assertPoliceReady,
  checkRequiredDocuments,
  findProfileFieldFile,
}