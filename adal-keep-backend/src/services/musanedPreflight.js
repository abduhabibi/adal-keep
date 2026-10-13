/**
 * musanedPreflight.js — what a profile must have before Musaned is started.
 * Shared by the start route (refuse early) and the workflow (refuse again).
 */

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_ROOT = path.join(HERE, '..', '..')
const SAFE_STORAGE = path.join(BACKEND_ROOT, 'data', 'SafeStorage')

/** Digits of a mobile number, without the 251 country code or a leading 0. */
export function normalizeMobile(raw) {
  let d = String(raw || '').replace(/\D/g, '')
  if (d.startsWith('251') && d.length > 9) d = d.slice(3)
  if (d.length === 10 && d.startsWith('0')) d = d.slice(1)
  return d
}

/** Musaned wants 9 followed by 8 more digits. */
export function mobileOk(raw) {
  return /^9\d{8}$/.test(normalizeMobile(raw))
}

/** Missing items for Musaned, as plain words. Empty = ready to start. */
export function musanedMissing(profile, hasPhoto) {
  const missing = []
  if (!hasPhoto) missing.push('personal photo')
  if (!String(profile?.marital_status || '').trim()) missing.push('marital status')
  if (!String(profile?.religion || '').trim()) missing.push('religion')
  if (!mobileOk(profile?.phone_number)) missing.push('mobile number (9 followed by 8 digits)')
  return missing
}

/** Is a Photo file for this profile present on disk? */
export async function photoOnFile(db, profileId) {
  const rows = await db('files')
    .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', profileId)
    .andWhere('profile_fields.name', 'Photo')
    .select('files.path')
    .orderBy('files.id', 'desc')
  for (const r of rows) {
    const candidates = [
      path.join(SAFE_STORAGE, path.basename(r.path)),
      path.join(BACKEND_ROOT, r.path),
      path.join(process.cwd(), r.path),
    ]
    if (candidates.some(c => fs.existsSync(c))) return true
  }
  return false
}

export default { musanedMissing, mobileOk, normalizeMobile, photoOnFile }
