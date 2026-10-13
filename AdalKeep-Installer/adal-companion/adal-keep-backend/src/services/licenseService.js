import bcrypt from 'bcryptjs'
import db from '../config/database.js'
import { generateFingerprint } from './fingerprint.js'
import logger from '../utils/logger.js'

const DEFAULT_DEV_PASSWORD = '759126348'

// Called once on server start
export async function checkLicenseOnStartup() {
  const currentFingerprint = generateFingerprint()

  let license = await db('license').orderBy('id', 'asc').first()

  if (!license) {
    // First run: create license row with default dev password hash
    const devHash = await bcrypt.hash(DEFAULT_DEV_PASSWORD, 10)
    await db('license').insert({
      fingerprint_hash: currentFingerprint,
      dev_password_hash: devHash,
    })
    logger.info('License initialized – fingerprint stored.')
    return { valid: true }
  }

  // Compare fingerprints
  if (currentFingerprint !== license.fingerprint_hash) {
    logger.error('HARDWARE MISMATCH – Server lock down.')
    return {
      valid: false,
      reason: 'Hardware fingerprint mismatch. Server locked.',
    }
  }

  // Update last_checked
  await db('license').where({ id: license.id }).update({ last_checked: db.fn.now() })
  return { valid: true }
}

// Reset fingerprint after correct dev password
export async function resetFingerprint(devPassword) {
  const license = await db('license').orderBy('id', 'asc').first()
  if (!license) throw new Error('No license record')

  const match = await bcrypt.compare(devPassword, license.dev_password_hash)
  if (!match) throw new Error('Invalid dev password')

  const newFingerprint = generateFingerprint()
  await db('license').where({ id: license.id }).update({
    fingerprint_hash: newFingerprint,
    last_checked: db.fn.now(),
  })

  logger.info('Fingerprint reset successful.')
  return newFingerprint
}

// Change dev password (requires old password)
export async function changeDevPassword(oldPassword, newPassword) {
  const license = await db('license').orderBy('id', 'asc').first()
  if (!license) throw new Error('No license record')

  const match = await bcrypt.compare(oldPassword, license.dev_password_hash)
  if (!match) throw new Error('Invalid old password')

  const newHash = await bcrypt.hash(newPassword, 10)
  await db('license').where({ id: license.id }).update({ dev_password_hash: newHash })

  logger.info('Dev password changed.')
}