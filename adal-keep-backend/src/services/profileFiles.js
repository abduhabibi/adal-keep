import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import db from '../config/database.js'
import logger from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_ROOT = path.join(__dirname, '../../uploads')

const FIELD_NAME_MAP = {
  Passport: 'Passport',
  CV: 'CV',
  'Government ID': 'Government ID',
  'Government-ID': 'Government ID',
  'National ID': 'Government ID',
  'Medical Report': 'Medical Report',
  'Medical-Report': 'Medical Report',
  Medical: 'Medical Report',
  COC: 'COC',
  Visa: 'Visa',
  Contract: 'Contract',
  Insurance: 'Insurance',
  'Saudi-letter': 'Saudi-letter',
  Certificate: 'Certificate',
  Other: 'Other'
}

function mimeOf(filename) {
  const e = path.extname(filename || '').toLowerCase()
  if (e === '.pdf') return 'application/pdf'
  if (e === '.png') return 'image/png'
  if (e === '.webp') return 'image/webp'
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}

async function ensureFieldRow(profileId, fieldName) {
  let pf = await db('profile_fields').where({ profile_id: profileId, name: fieldName }).first()
  if (pf) return pf
  let templateId = null
  try {
    const tpl = await db('field_templates').where({ name: fieldName }).first()
    templateId = tpl?.id || null
  } catch {}
  const cols = await db('profile_fields').columnInfo()
  const row = {
    profile_id: profileId,
    field_template_id: templateId,
    name: fieldName,
    data_type: 'file',
    is_permanent: templateId ? 1 : 0,
    value_text: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  }
  const insert = {}
  for (const [k, v] of Object.entries(row)) if (cols[k] !== undefined) insert[k] = v
  const [id] = await db('profile_fields').insert(insert)
  return db('profile_fields').where({ id }).first()
}

/** Set/update a text value on a named profile field */
export async function setProfileFieldText(profileId, fieldName, value) {
  if (!profileId || !fieldName) return null
  const pf = await ensureFieldRow(profileId, fieldName)
  const cols = await db('profile_fields').columnInfo()
  const patch = { updated_at: new Date().toISOString() }
  if (cols.value_text !== undefined) patch.value_text = value == null ? null : String(value)
  await db('profile_fields').where({ id: pf.id }).update(patch)
  return pf
}

/**
 * Attach a file from disk to a profile field.
 * Never treats passport/medical/visa/coc/contract as "personal media".
 */
export async function attachFileToProfile(profileId, fieldOrSlot, storedPath, originalFilename) {
  if (!profileId || !storedPath) {
    logger.warn('[profileFiles] missing profileId or path')
    return null
  }

  const fieldName = FIELD_NAME_MAP[fieldOrSlot] || String(fieldOrSlot || 'Other').trim() || 'Other'
  const filename = originalFilename || path.basename(storedPath)
  const ext = path.extname(filename).toLowerCase()
  if (['.mp4', '.mov', '.avi', '.mkv', '.mp3', '.wav'].includes(ext)) {
    logger.info(`[profileFiles] Skipping AV: ${filename}`)
    return null
  }

  const pf = await ensureFieldRow(profileId, fieldName)

  const destDir = path.join(UPLOAD_ROOT, 'profiles', String(profileId))
  await fs.mkdir(destDir, { recursive: true })
  const destName = `${Date.now()}_${filename}`.replace(/\s+/g, '_')
  const destPath = path.join(destDir, destName)

  try {
    await fs.copyFile(storedPath, destPath)
  } catch {
    try {
      await fs.rename(storedPath, destPath)
    } catch (e) {
      logger.error(`[profileFiles] copy failed: ${e.message}`)
    }
  }

  let size = 0
  let finalPath = destPath
  try {
    size = (await fs.stat(destPath)).size
  } catch {
    finalPath = storedPath
    try { size = (await fs.stat(storedPath)).size } catch {}
  }

  const [fileId] = await db('files').insert({
    profile_field_id: pf.id,
    original_name: filename,
    path: finalPath,
    mimetype: mimeOf(filename),
    size,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })

  await db('profile_fields').where({ id: pf.id }).update({
    value_text: filename,
    updated_at: new Date().toISOString()
  })

  logger.info(`[profileFiles] ${fieldName} → profile ${profileId} field ${pf.id} file ${fileId}`)
  return { profileFieldId: pf.id, fileId, path: finalPath }
}

export default { attachFileToProfile, setProfileFieldText }
