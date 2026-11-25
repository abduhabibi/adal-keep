/**
 * adalLock.js — Adal's lock, and nothing else: the licence Adal signed for this PC, the
 * main PC's signed licence (kept on the agency's other PCs), and whether they lock.
 *
 * In a file of its own (owner, 2026-11-25): whatever goes wrong here, Adal Keep opens —
 * except that a signed lock already received stays. lockNow() never throws.
 *
 * Each signed file is kept twice (data/ and outside the install folder) and the newest
 * signed one counts: an edited, deleted or older copy opens nothing.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import { verifyManifest } from './updateChannel.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DIR = process.env.ADAL_LICENSE_DIR || path.join(HERE, '..', '..', 'data')
// The second copy, outside the install folder (a test only writes where it says).
const SIDE = process.env.ADAL_LICENSE_SIDE || (process.env.NODE_TEST_CONTEXT ? null
  : process.platform === 'win32' ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'AdalKeep') : path.join(os.homedir(), '.config', 'adal-keep'))

/** The licence's signed part (what Adal signs and the PC checks). */
export const signedPart = (l) => ({
  pc: String(l.pc || ''), plan: l.plan || 'premium',
  paid_until: l.paid_until || null, trial_until: l.trial_until || null,
  features: l.features || {}, offers: l.offers || [], note: l.note || '', at: l.at || null,
  // Only when set: a licence that is not suspended is signed exactly as before
  // (PCs on an older version keep accepting it).
  ...(l.suspended ? { suspended: { at: l.suspended.at || null, note: String(l.suspended.note || '').slice(0, 300) } } : {}),
})
export function verifyLicense(file, pc) {
  if (!file?.license || !file?.signature) return null
  const l = signedPart(file.license)
  if (pc && l.pc !== String(pc)) return null
  return verifyManifest(l, file.signature) ? l : null
}

const readJSON = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const copies = (name) => [path.join(DIR, name), ...(SIDE ? [path.join(SIDE, name)] : [])]
const writeCopies = (name, o) => { for (const p of copies(name)) try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 1)) } catch {} }
const putRight = (name, o) => { if (copies(name).some(p => JSON.stringify(readJSON(p)) !== JSON.stringify(o))) writeCopies(name, o) }
const when = (l) => Date.parse(l?.at || '') || 0

// ── This PC's own licence ───────────────────────────────────────────────────
let current = null       // the verified licence in use
let currentFile = null   // … as Adal signed it ({license, signature}), for the other PCs of the agency
let loadedFor = null
/** The newest licence Adal signed for this PC, of the copies kept here. */
export function loadSaved(pc) {
  for (const p of copies('license.json')) {
    const file = readJSON(p)
    let l = null
    try { l = verifyLicense(file, pc) } catch {}
    if (l && (!current || when(l) > when(current))) { current = l; currentFile = { license: file.license, signature: file.signature } }
  }
  // A copy that was deleted, edited or is older is put right.
  if (currentFile) putRight('license.json', currentFile)
}
/** The licence in use; with the PC's number: read from this PC's copies the first time (a lock holds from the first moment). */
export function licenseNow(pc) {
  if (pc && loadedFor !== pc) { loadedFor = pc; if (!current) loadSaved(pc) }
  return current
}
export const licenseFile = () => currentFile
/** A newer licence from Adal (already verified): in use and kept. */
export function useLicense(l, file) {
  current = l; currentFile = { license: file.license, signature: file.signature }
  writeCopies('license.json', currentFile)
}

// ── The main PC's licence, kept on the agency's other PCs ───────────────────
// {main PC's number: its newest signed file}: only what Adal signed counts, an older one never replaces a newer.
let agencyFiles = null, lastSeenSig = null
function kept() {
  if (agencyFiles) return agencyFiles
  agencyFiles = {}
  for (const p of copies('agency-license.json')) for (const f of Object.values(readJSON(p) || {})) keepNewer(f)
  if (Object.keys(agencyFiles).length) putRight('agency-license.json', agencyFiles)
  return agencyFiles
}
function keepNewer(file) {
  let l = null
  try { l = verifyLicense(file) } catch {}
  if (!l || !/^\d{6}$/.test(l.pc)) return false
  const had = agencyFiles[l.pc]
  if (had && when(had.license) >= when(l)) return false
  agencyFiles[l.pc] = { license: l, signature: file.signature }
  return true
}
/** The main PC's signed licence, as it came through the copying. */
export function keepAgencyLicense(file) {
  if (!file?.signature || file.signature === lastSeenSig) return
  lastSeenSig = file.signature
  kept()
  if (keepNewer(file)) writeCopies('agency-license.json', agencyFiles)
}
/** The main PCs' numbers whose lock holds here. */
export const lockedAgencyNumbers = () => Object.keys(kept()).filter(n => agencyFiles[n].license?.suspended)

// ── Locked or not ───────────────────────────────────────────────────────────
let held = null   // the last signed lock seen while running
const word = (x) => ({ at: x.at || null, note: x.note || '' })
let saidAt = 0
export function say(where, e) { if (Date.now() - saidAt > 60000) { saidAt = Date.now(); console.warn(`[licence] ${where}: ${e?.message || e} — Adal Keep stays open`) } }

/**
 * What locks this PC, or null. Never throws: a part that fails counts as "no lock", but a
 * signed lock already seen stays while that part cannot be read.
 *   pc   gives this PC's number;  follow  gives {licence, cutOff} on a Companion, or null
 */
export function lockNow({ pc, follow }) {
  let failed = false, lock = null, cut = null
  try {
    const f = follow?.() || null
    cut = f?.cutOff || null
    if (f?.licence?.adal) keepAgencyLicense(f.licence.adal)
  } catch (e) { say('the main PC\'s word', e) }
  try { const own = licenseNow(pc())?.suspended; if (own) lock = word(own) } catch (e) { failed = true; say('this PC\'s licence', e) }
  if (!lock) try { const [n] = lockedAgencyNumbers(); if (n) lock = word(agencyFiles[n].license.suspended) } catch (e) { failed = true; say('the agency\'s licence', e) }
  if (lock) return (held = lock)
  if (failed && held) return held
  held = null
  return cut ? { at: null, note: `This PC was ${cut} by the main PC.` } : null
}

/** Tests only: the licence in use, without a signature / everything forgotten, as after a restart. */
export function __setLicenseForTest(l) { if (process.env.NODE_TEST_CONTEXT) { current = l; currentFile = null; loadedFor = null } }
export function __resetLicenseForTest() { if (process.env.NODE_TEST_CONTEXT) { current = currentFile = loadedFor = agencyFiles = lastSeenSig = held = null } }
