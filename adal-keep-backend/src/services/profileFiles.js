import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import db from '../config/database.js'
import logger from '../utils/logger.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const UPLOAD_ROOT = path.join(__dirname, '../../uploads')

/**
 * Ensure a profile_field row exists for this field name, then store file in `files`.
 * Matches UI slots: Passport, CV, Government ID, Medical Report, etc.
 */
export async function attachFileToProfile(profileId, fieldName, sourcePath, originalName) {
  if (!profileId || !sourcePath) return null

  // Ignore personal images/videos and non-listed fields (as requested)
  if (['personal image', 'personal video', 'selfie', 'photo', 'video'].some(term => 
      String(originalName || '').toLowerCase().includes(term))) {
    if (!['Photo', 'Self Video'].includes(fieldName)) {
      logger.info(`[profileFiles] Ignoring personal media: ${originalName}`)
      return null
    }
  }

  // REFUSE_CV_AS_PASSPORT
  const lowerName = String(originalName || sourcePath || '').toLowerCase()
  const looksCvName = /\bcv\b|resume|curriculum/.test(lowerName)
  if (fieldName === 'Passport' && looksCvName) {
    logger.warn(`[profileFiles] Refused CV filename into Passport → forcing CV`)
    fieldName = 'CV'
  }

  const name = fieldName // e.g. Passport, CV, Government ID
  let field = await db('profile_fields')
    .where({ profile_id: profileId, name })
    .first()

  if (!field) {
    // try field_templates for template id
    let templateId = null
    try {
      const tpl = await db('field_templates').where({ name }).first()
      templateId = tpl?.id || null
    } catch {}

    const [fid] = await db('profile_fields').insert({
      profile_id: profileId,
      field_template_id: templateId,
      name,
      data_type: 'file',
      is_permanent: 0,
      value_text: originalName || path.basename(sourcePath),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    field = await db('profile_fields').where({ id: fid }).first()
  } else {
    await db('profile_fields').where({ id: field.id }).update({
      value_text: originalName || path.basename(sourcePath),
      updated_at: new Date().toISOString()
    })
  }

  const dir = path.join(UPLOAD_ROOT, 'profiles', String(profileId))
  await fs.mkdir(dir, { recursive: true })
  const base = originalName || path.basename(sourcePath)
  const destName = `${Date.now()}_${base}`.replace(/\s+/g, '_')
  const dest = path.join(dir, destName)

  try {
    await fs.copyFile(sourcePath, dest)
  } catch (err) {
    logger.warn(`[profileFiles] copy failed: ${err.message}`)
    return null
  }

  // Remove old files for this field
  try {
    const old = await db('files').where({ profile_field_id: field.id })
    for (const f of old) {
      if (f.path) await fs.unlink(f.path).catch(() => {})
    }
    await db('files').where({ profile_field_id: field.id }).del()
  } catch {}

  let mime = null
  try {
    const ext = path.extname(base).toLowerCase()
    mime = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' }[ext] || null
  } catch {}

  let size = null
  try {
    const st = await fs.stat(dest)
    size = st.size
  } catch {}

  const [fileId] = await db('files').insert({
    profile_field_id: field.id,
    original_name: base,
    path: dest,
    mimetype: mime,
    size,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  })

  logger.info(`[profileFiles] ${name} → profile ${profileId} field ${field.id} file ${fileId}`)
  return { fieldId: field.id, fileId, dest }
}

/**
 * Set text value on a named profile field (e.g. National ID number)
 */
export async function setProfileFieldText(profileId, fieldName, value) {
  if (!profileId || value == null || value === '') return
  let field = await db('profile_fields').where({ profile_id: profileId, name: fieldName }).first()
  if (!field) {
    const [fid] = await db('profile_fields').insert({
      profile_id: profileId,
      name: fieldName,
      data_type: 'text',
      is_permanent: 0,
      value_text: String(value),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    return fid
  }
  await db('profile_fields').where({ id: field.id }).update({
    value_text: String(value),
    updated_at: new Date().toISOString()
  })
  return field.id
}

export default { attachFileToProfile, setProfileFieldText }
