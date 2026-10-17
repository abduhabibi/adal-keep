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

/** Missing items for Musaned, as plain words. Empty = ready to start.
 *  `hasPhoto`: true, false, or 'passport-crop' (only the face cut from the
 *  passport is on file — Musaned needs a real personal photo). */
export function musanedMissing(profile, hasPhoto) {
  const missing = []
  if (hasPhoto === 'passport-crop') missing.push('personal photo (only the face cut from the passport is on file — upload a real photo)')
  else if (!hasPhoto) missing.push('personal photo')
  if (!String(profile?.marital_status || '').trim()) missing.push('marital status')
  if (!String(profile?.religion || '').trim()) missing.push('religion')
  if (!mobileOk(profile?.phone_number)) missing.push('mobile number (9 followed by 8 digits)')
  return missing
}

/**
 * The old ingestion split "composite" scans and saved the face cut out of the
 * passport page into the Photo field as "<name>_photo.jpg". That is the
 * passport picture, not a personal photo, so Musaned must never upload it.
 */
export function isPassportCrop(filePath) {
  return /_photo\.jpe?g$/i.test(path.basename(String(filePath || '')))
}

/** Absolute path of a stored file, or null when it is not on disk. */
export function storedFilePath(relPath) {
  const candidates = [
    path.join(SAFE_STORAGE, path.basename(relPath)),
    path.isAbsolute(relPath) ? relPath : null,
    path.join(BACKEND_ROOT, relPath),
    path.join(process.cwd(), relPath),
  ].filter(Boolean)
  return candidates.find(c => fs.existsSync(c)) || null
}

/**
 * The real personal photo for Musaned: the newest image in the profile's
 * Photo field that is on disk and is not a passport crop.
 * @returns {{ path: string, id: number } | { path: null, passportCropOnly: boolean }}
 */
export async function personalPhotoFile(db, profileId) {
  const rows = await db('files')
    .join('profile_fields', 'files.profile_field_id', 'profile_fields.id')
    .where('profile_fields.profile_id', profileId)
    .andWhere('profile_fields.name', 'Photo')
    .select('files.id', 'files.path', 'files.mimetype', 'files.size')
    .orderBy('files.id', 'desc')
  let crops = 0
  for (const r of rows) {
    if (isPassportCrop(r.path)) { crops++; continue }
    if (r.mimetype && !/^image\//.test(r.mimetype)) continue
    const abs = storedFilePath(r.path)
    if (abs) return { path: abs, id: r.id }
  }
  return { path: null, passportCropOnly: crops > 0 }
}

/** true / false / 'passport-crop' — see musanedMissing(). */
export async function photoOnFile(db, profileId) {
  const r = await personalPhotoFile(db, profileId)
  if (r.path) return true
  return r.passportCropOnly ? 'passport-crop' : false
}

export default { musanedMissing, mobileOk, normalizeMobile, photoOnFile, personalPhotoFile, isPassportCrop, storedFilePath }
