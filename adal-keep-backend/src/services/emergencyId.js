/**
 * emergencyId.js — her emergency contact's ID card (asked on 2026-11-19).
 *
 * Anyone puts the ID card of her emergency contact person into her
 * "Emergency Contact ID" document box; Adal Keep reads it at once (the same
 * reader as CVs and contracts: docDetails.js) and fills her emergency name,
 * phone and gender, so her profile and the LMIS contract (emergency contact)
 * use the person on the card.
 */
import { storedFilePath } from './musanedPreflight.js'

export const EMERGENCY_ID_FIELD = 'Emergency Contact ID'

/** The emergency details read from the card → the profile columns to write (only what was read). */
export function emergencyUpdates(read = {}) {
  const out = {}
  const name = String(read.emergency_name || '').replace(/\s+/g, ' ').trim()
  if (name.split(' ').length >= 2) out.emergency_name = name.toUpperCase()
  const phone = String(read.emergency_phone || '').trim()
  if (phone.replace(/\D/g, '').length >= 9) out.emergency_phone = phone
  if (read.gender === 'M') out.emergency_gender = 'Male'
  else if (read.gender === 'F') out.emergency_gender = 'Female'
  return out
}

/** Reads the card just put into her Emergency Contact ID box and fills her emergency details. */
export async function readEmergencyId(db, profileId, fileRow, log = (m) => console.log(`[emergency-id] ${m}`)) {
  const file = fileRow?.path && storedFilePath(fileRow.path)
  if (!file) { log(`profile ${profileId}: the card's file is not on this PC`); return {} }
  const t0 = Date.now()
  const { readDocumentDetails } = await import('./docDetails.js')
  const read = await readDocumentDetails(file, 'Emergency ID', (m) => log(`profile ${profileId}: ${m}`))
  const updates = emergencyUpdates(read)
  if (!Object.keys(updates).length) { log(`profile ${profileId}: nothing readable on the card`); return {} }
  await db('profiles').where('id', profileId).update({ ...updates, updated_at: new Date().toISOString() })
  log(`profile ${profileId}: emergency details from the ID card in ${Math.round((Date.now() - t0) / 100) / 10}s — ${Object.keys(updates).join(', ')}`)
  return updates
}
