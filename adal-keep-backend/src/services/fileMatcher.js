import path from 'path'
import db from '../config/database.js'
import logger from '../utils/logger.js'
import { attachFileToProfile, setProfileFieldText } from './profileFiles.js'

/**
 * Priority: filename wins over weak OCR labels
 */
export function guessDocType(filename, extracted = {}) {
  // Content classifier already decided
  if (extracted._forcedField && extracted._forcedField !== 'Other') {
    return extracted._forcedField
  }
  const n = (filename || '').toLowerCase()
  const doc = (extracted.document_type || '').toLowerCase()

  // Filename is authoritative for common types
  if (/\bcv\b|resume|curriculum|\.docx?$/.test(n)) return 'CV'
  if (/medical|clinic|የጤና/.test(n)) return 'Medical Report'
  if (/\bcoc\b/.test(n)) return 'COC'
  if (/visa/.test(n)) return 'Visa'
  if (/contract/.test(n)) return 'Contract'
  if (/insurance/.test(n)) return 'Insurance'
  if (/saudi/.test(n)) return 'Saudi-letter'
  if (/cert|diploma/.test(n)) return 'Certificate'
  if (/\bid\b|national|kebele|fayda|government/.test(n)) return 'Government ID'
  if (/passport|pp[-_ ]?scan|pass\b/.test(n)) return 'Passport'

  // OCR type
  if (doc === 'cv') return 'CV'
  if (doc === 'passport') return 'Passport'
  if (doc === 'national_id') return 'Government ID'

  // Content hints
  if (extracted.passport_number && !extracted.national_id) return 'Passport'
  if (extracted.national_id) return 'Government ID'

  return null
}

export async function findExistingProfile(extracted = {}) {
  if (extracted.passport_number) {
    const byPass = await db('profiles')
      .where({ passport_number: extracted.passport_number })
      .orderBy('id', 'desc')
      .first()
    if (byPass) return byPass
  }
  if (extracted.full_name) {
    const name = String(extracted.full_name).trim()
    if (name.length > 3) {
      const byName = await db('profiles')
        .whereRaw('LOWER(full_name) = ?', [name.toLowerCase()])
        .orderBy('id', 'desc')
        .first()
      if (byName) return byName
    }
  }
  return null
}

export async function matchFileToChecklist(filename, storedPath, extracted = {}) {
  const kind = guessDocType(filename, extracted)
  if (!kind) {
    logger.info(`[PhaseD] Unknown kind for ${filename} – left in processed only`)
    return null
  }

  // Prefer profile that already exists for this person
  let profile = await findExistingProfile(extracted)

  // Else open checklist task
  const tasks = await db('tasks')
    .where({ type: 'ai_file_checklist' })
    .whereIn('status', ['pending', 'in_progress', 'todo', 'ongoing'])
    .orderBy('id', 'desc')

  let targetTask = null
  if (!profile) {
    for (const task of tasks) {
      if (task.profile_id) {
        profile = await db('profiles').where({ id: task.profile_id }).first()
        targetTask = task
        break
      }
    }
  } else {
    targetTask = tasks.find(t => t.profile_id === profile.id) || null
  }

  // Last resort: latest in_progress profile
  if (!profile) {
    profile = await db('profiles').where({ status: 'in_progress' }).orderBy('id', 'desc').first()
  }

  if (!profile) {
    logger.info(`[PhaseD] No profile to attach ${kind} (${filename})`)
    return null
  }

  await attachFileToProfile(profile.id, kind, storedPath, filename)

  if (kind === 'Government ID' && extracted.national_id) {
    await setProfileFieldText(profile.id, 'National ID', extracted.national_id)
    try {
      const cols = await db('profiles').columnInfo()
      if (cols.national_id) {
        await db('profiles').where({ id: profile.id }).update({
          national_id: extracted.national_id,
          updated_at: new Date().toISOString()
        })
      }
    } catch {}
  }

  if (targetTask) {
    let payload = {}
    try { payload = targetTask.payload ? JSON.parse(targetTask.payload) : {} } catch {}
    const attached = [...new Set([...(payload.attached || []), kind])]
    payload.attached = attached
    payload.files = { ...(payload.files || {}), [kind]: storedPath }
    const required = payload.required || ['Passport', 'Self Video', 'Photo']
    const allRequiredDone = required.every(r => attached.includes(r))
    await db('tasks').where({ id: targetTask.id }).update({
      payload: JSON.stringify(payload),
      status: allRequiredDone ? 'in_progress' : targetTask.status,
      description: `Attached: ${attached.join(', ')}`,
      updated_at: new Date().toISOString()
    })

    // New: If all core documents are ready, create Pextran approval task (pennywise - only one task)
    if (allRequiredDone && !payload.pextranTaskCreated) {
      await db('tasks').insert({
        title: `Pextran Approval: ${profile.full_name}`,
        description: `All required documents ready for ${profile.full_name}.\n\nApprove to start Pextran automation (Passport upload + form fill + CV).`,
        type: 'ai_pextran_approval',
        status: 'pending',
        priority: 'high',
        profile_id: profile.id,
        is_ai_created: 1,
        created_by: 'AI-Completion',
        payload: JSON.stringify({
          stage: 'pextran_approval',
          profile_id: profile.id,
          full_name: profile.full_name,
          required: required,
          attached
        }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
      payload.pextranTaskCreated = true
      await db('tasks').where({ id: targetTask.id }).update({ payload: JSON.stringify(payload) })
    }
  }

  logger.info(`[PhaseD] ${kind} → profile #${profile.id} (${profile.full_name})`)
  return { kind, profileId: profile.id, taskId: targetTask?.id }
}

export default { guessDocType, matchFileToChecklist, findExistingProfile }
