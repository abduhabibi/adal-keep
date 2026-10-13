/**
 * uploadPreflight.js — validate every file BEFORE the police-certificate
 * workflow touches LMIS.
 *
 * Why this exists
 * ---------------
 * `stepUploadDocuments()` commits to LMIS *during* the step: the payment slip
 * is uploaded and its "Add" submitted before the passport is even opened. So if
 * a later file turns out to be missing, empty or oversized, LMIS is left with a
 * half-submitted certificate, and every retry re-uploads the slip.
 *
 * That is exactly what happened while `setReactSelect()` was throwing
 * `page.keyboard.insertText is not a function` at the first passport field:
 * four attempts on one worker meant up to four duplicate slips.
 *
 * Checking all three files up-front makes that class of partial submission
 * impossible — the workflow refuses to start rather than failing halfway.
 */

import fs from 'fs'
import path from 'path'

/** LMIS per-slot size limits (mirrored from the upload widgets). */
export const SLIP_MAX_MB = 5
export const PASSPORT_MAX_MB = 2
export const PHOTO_MAX_MB = 2

/**
 * @typedef {object} PreflightResult
 * @property {boolean}  ok        true when nothing blocks the upload step
 * @property {string[]} problems  human-readable reasons, empty when ok
 */

/**
 * Validate every file the police-certificate upload step needs.
 *
 * @param {{slipPath?:string, passportPath?:string, photoPath?:string}} ctx
 * @returns {PreflightResult}
 */
export function preflightUploads(ctx) {
  const problems = []

  const check = (label, filePath, maxMb) => {
    if (!filePath) {
      problems.push(`${label}: no file attached to the profile`)
      return
    }
    if (!fs.existsSync(filePath)) {
      problems.push(`${label}: file missing on disk (${path.basename(filePath)})`)
      return
    }
    let bytes = 0
    try {
      bytes = fs.statSync(filePath).size
    } catch (e) {
      problems.push(`${label}: cannot read ${path.basename(filePath)} (${e.message})`)
      return
    }
    if (bytes === 0) {
      problems.push(`${label}: file is empty (${path.basename(filePath)})`)
      return
    }
    const mb = bytes / 1024 / 1024
    if (mb > maxMb) {
      problems.push(
        `${label}: ${mb.toFixed(2)}MB exceeds LMIS ${maxMb}MB limit (${path.basename(filePath)})`
      )
    }
  }

  check('Payment slip', ctx?.slipPath, SLIP_MAX_MB)
  check('Passport', ctx?.passportPath, PASSPORT_MAX_MB)
  check('Photo', ctx?.photoPath, PHOTO_MAX_MB)

  return { ok: problems.length === 0, problems }
}

export default { preflightUploads, SLIP_MAX_MB, PASSPORT_MAX_MB, PHOTO_MAX_MB }
