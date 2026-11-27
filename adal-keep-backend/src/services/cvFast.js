/**
 * cvFast.js — a CV download in about a second (the owner, 2026-11-27). "Download PDF" made her
 * PDF again on every click: the pictures read and drawn, the PDF browser, a new CV row and file
 * each time. Now her ready CV is served straight from the disk when nothing it is made of changed:
 *   her profile row (contract data in it), every file of hers (photo, full body, passport …),
 *   the template (with its header / footer pictures), her broker, the form's choices, and the
 *   CV code itself. Any of those changes → a new key → made again, as before.
 * The ready one is the same generated_cvs / files rows: nothing new on her CV list, the same
 * file id, served by /api/files/:id/download (streamed from disk, with its length).
 * Kept in data/cv-fast.json (this PC's own: each PC knows which of its files are ready).
 * Off: ADAL_CV_FAST=0 — made on every click, as before.
 */
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

export const cvFastOn = (env = process.env) => env.ADAL_CV_FAST !== '0'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACKEND = path.join(HERE, '..', '..')
const MAP = () => process.env.ADAL_CV_FAST_FILE || path.join(BACKEND, 'data', 'cv-fast.json')
const MAX = 800

// The code that draws a CV: a new version of it makes every CV again.
let codeTag = null
function codeVersion() {
  if (codeTag) return codeTag
  const parts = []
  for (const f of [path.join(HERE, 'cvRender.js'), path.join(HERE, '..', 'routes', 'cv.js'), path.join(HERE, 'contractFields.js'), path.join(HERE, 'bodySize.js')]) {
    try { const s = fs.statSync(f); parts.push(`${path.basename(f)}:${s.size}:${Math.round(s.mtimeMs)}`) } catch { parts.push(path.basename(f)) }
  }
  return (codeTag = parts.join('|'))
}
export const _resetCodeTag = () => { codeTag = null }

/** A row without its times (a look or a sync touches those; the CV does not show them). */
const content = (row) => row ? Object.fromEntries(Object.entries(row).filter(([k]) => !/(_at|_seen)$/.test(k)).sort(([a], [b]) => a.localeCompare(b))) : null
const stable = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))

/** Everything her CV with this template is made of, as one hash. */
export async function cvInputKey(db, profile, template, overrides = {}) {
  const files = await db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', profile.id).whereNot('profile_fields.name', 'CV')
    .select('profile_fields.name', 'files.id', 'files.path', 'files.size', 'files.content_hash').orderBy('files.id')
    .catch(() => db('profile_fields').join('files', 'files.profile_field_id', 'profile_fields.id').where('profile_fields.profile_id', profile.id)
      .whereNot('profile_fields.name', 'CV').select('profile_fields.name', 'files.id', 'files.path', 'files.size').orderBy('files.id'))
  const broker = profile.broker_id ? await db('brokers').where('id', profile.broker_id).first().catch(() => null) : null
  const pics = []
  for (const f of [template.header_path, template.footer_path, template.logo_path].filter(Boolean)) pics.push(f)
  return crypto.createHash('sha256').update(stable({
    v: 1, code: codeVersion(), profile: content(profile), template: content(template), pics, broker: content(broker), files, overrides,
  })).digest('hex').slice(0, 32)
}

// ------------------------------------------------------------- the map --
let map = null
function load() {
  if (map) return map
  try { map = JSON.parse(fs.readFileSync(MAP(), 'utf8')) || {} } catch { map = {} }
  return map
}
function save() {
  try {
    const keys = Object.keys(map)
    if (keys.length > MAX) for (const k of keys.sort((a, b) => (map[a].at || 0) - (map[b].at || 0)).slice(0, keys.length - MAX)) delete map[k]
    fs.mkdirSync(path.dirname(MAP()), { recursive: true })
    const tmp = MAP() + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(map)); fs.renameSync(tmp, MAP())
  } catch {}
}
export const _resetMap = () => { map = null }

/**
 * Her ready CV for this key, if its rows and its file are still here (a CV moved to the
 * Trash, or its file gone, is not used). → what generateCvFile returns, or null.
 */
export async function readyCv(db, key, resolve) {
  if (!cvFastOn()) return null
  const hit = load()[key]
  if (!hit) return null
  try {
    const [cv, file] = await Promise.all([
      db('generated_cvs').where('id', hit.generated_cv_id).first('id', 'filename', 'pdf_path'),
      db('files').where('id', hit.file_id).first(),
    ])
    const full = cv && file ? resolve(file) : null
    if (!full || !fs.existsSync(full)) { delete map[key]; save(); return null }
    hit.at = Date.now(); save()
    return { generated_cv_id: cv.id, file_id: file.id, filename: cv.filename, original_name: file.original_name, path: full, ready: true }
  } catch { return null }
}
export function rememberCv(key, made) {
  if (!cvFastOn() || !key || !made?.file_id) return
  load()[key] = { generated_cv_id: made.generated_cv_id, file_id: made.file_id, at: Date.now() }
  save()
}
