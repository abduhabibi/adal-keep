/**
 * identity.js — who this PC is among the agency's PCs (data/sync-id.json).
 *
 *   pc_id   random, made once on this PC (12 hex), never copied to another
 *   slot    0–999, the last three digits of every id this PC makes (ids.js);
 *           the main PC hands it out when a PC joins (sync_pcs)
 *   key     this PC's key for the agency's other PCs (the x-adal-pc header);
 *           only its hash is in sync_pcs
 *
 * It lives beside the database, not in it: a Companion's first copy of the
 * database comes whole from the main PC, with the main PC's own rows in it,
 * and this PC must stay itself.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'data')
export const idFile = () => process.env.ADAL_SYNC_ID || path.join(DATA, 'sync-id.json')

let cached = null
export function readIdentity() {
  if (cached) return cached
  const f = idFile()
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (/^[0-9a-f]{12}$/.test(j.pc_id) && Number.isInteger(j.slot)) { cached = j; return j }
  } catch {}
  const j = { pc_id: crypto.randomBytes(6).toString('hex'), slot: 1, key: crypto.randomBytes(32).toString('base64url'), created_at: new Date().toISOString() }
  writeIdentity(j)
  return j
}
export function writeIdentity(j) {
  const f = idFile()
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(j, null, 1), { mode: 0o600 })
  fs.renameSync(tmp, f)
  cached = j
}
export function updateIdentity(patch) { const j = { ...readIdentity(), ...patch }; writeIdentity(j); return j }
export const keyHash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex')
/** For tests: forget what was read. */
export function forgetIdentity() { cached = null }
