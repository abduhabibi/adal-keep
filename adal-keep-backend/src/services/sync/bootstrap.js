/**
 * bootstrap.js — a Companion joins the agency: its own full copy, from the
 * main PC, over the office network.
 *
 *   1. In with the main PC's number (5 or 6 digits, as before:
 *      /pc-access/number) → this PC's key.
 *   2. /sync/join → its slot (the end of every id it makes) and its key on
 *      the agency's list (sync_pcs), so every PC knows it.
 *   3. The backup key, the vault key and the locked secrets (/replica/keys,
 *      as for the Companion's locked copy before) — the passwords in the
 *      database open with the agency's vault key.
 *   4. The database: a fresh snapshot of the main PC's (/replica/manifest),
 *      in locked 1 MB pieces (/replica/db) — the same pieces as the copy a
 *      Companion used to keep. Put in place at the next start (like a
 *      restore: the database open now cannot be swapped live); the one this
 *      PC had is kept beside it.
 *   5. The documents come after, by the normal rounds (docs.js), smallest
 *      first — the Companion works at once with what it has.
 *   6. Its online account (as before, /pc-access/online-copy), for the
 *      online copy when the office network does not reach the others.
 */
import fs from 'fs'
import zlib from 'zlib'
import crypto from 'crypto'

const MAGIC = Buffer.from('ADALBK1')   // telegramBackup.js's lock (lockFast)
const keys = new Map()
/** telegramBackup.unlock, with the key worked out once per salt (a copy is many pieces, all one salt). */
export function unlockPiece(buf, password) {
  if (!buf.subarray(0, 7).equals(MAGIC)) throw new Error('Not an Adal Keep piece')
  const salt = buf.subarray(7, 23), iv = buf.subarray(23, 35), tag = buf.subarray(35, 51)
  const id = `${password}\0${salt.toString('hex')}`
  if (!keys.has(id)) keys.set(id, crypto.scryptSync(password, salt, 32))
  const d = crypto.createDecipheriv('aes-256-gcm', keys.get(id), iv)
  d.setAuthTag(tag)
  try { return Buffer.concat([d.update(buf.subarray(51)), d.final()]) } catch { throw new Error('A piece that does not open with the backup key') }
}
const unpack = (buf, z) => (z === 'zstd' ? zlib.zstdDecompressSync(buf) : zlib.gunzipSync(buf))

export function normalizeMain(input) {
  let u = String(input || '').trim().replace(/\/+$/, '')
  if (!u) throw new Error('Type the main PC address')
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u
  const p = new URL(u)
  if (p.protocol === 'http:' && !p.port) p.port = '4000'
  return p.origin
}

export async function joinAgency({ mainUrl, number, name, pcId, lan = [], port = 4000, dbFile, f = fetch, progress = () => {}, onlineCopy = true }) {
  const main = normalizeMain(mainUrl)
  const json = async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(j.error || `The main PC answered ${r.status}`), { status: r.status, suspended: j.suspended }); return j }
  progress({ step: 'key' })
  const k = await json(await f(`${main}/api/pc-access/number`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ number: String(number || '').replace(/\D/g, ''), name: `${name} (Adal Keep Companion)`, cid: pcId }),
  }))
  if (!k.key) throw new Error('The main PC gave no key')
  const H = { 'x-adal-pc': k.key }
  progress({ step: 'join' })
  const j = await json(await f(`${main}/api/sync/join`, {
    method: 'POST', headers: { ...H, 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ pc_id: pcId, name, lan, port }),
  }))
  progress({ step: 'keys' })
  const secrets = await json(await f(`${main}/api/replica/keys`, { headers: H, signal: AbortSignal.timeout(15000) }))
  progress({ step: 'manifest' })
  const m = await json(await f(`${main}/api/replica/manifest`, { headers: H, signal: AbortSignal.timeout(180000) }))
  const parts = []
  for (let i = 0; i < m.db.chunks.length; i++) {
    progress({ step: 'database', done: i, of: m.db.chunks.length })
    let buf = null
    for (let tries = 0; tries < 4 && !buf; tries++) {
      try {
        const r = await f(`${main}/api/replica/db/${m.snap}/${i}`, { headers: H, signal: AbortSignal.timeout(120000) })
        if (!r.ok) throw new Error(`piece ${i}: ${r.status}`)
        buf = unpack(unlockPiece(Buffer.from(await r.arrayBuffer()), secrets.password), m.db.z)
      } catch (e) { if (tries === 3) throw e }
    }
    parts.push(buf)
  }
  const raw = Buffer.concat(parts)
  if (raw.length !== m.db.length) throw new Error('The copy of the database came incomplete — try again')
  if (raw.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') throw new Error('The copy is not a database')
  let online = null
  if (onlineCopy) {
    try { online = (await json(await f(`${main}/api/pc-access/online-copy`, { method: 'POST', headers: { ...H, 'content-type': 'application/json' }, body: JSON.stringify({ name }), signal: AbortSignal.timeout(30000) }))).cloud || null } catch {}
  }
  progress({ step: 'staged' })
  return { main, key: k.key, access_id: k.id, slot: j.slot, main_pc: j.main_pc, main_name: j.main_name, raw, secrets, online, made: m.made }
}

/**
 * Put what joinAgency brought in place for the next start: the database
 * (beside the one this PC had), the vault key and the secrets.
 */
export async function stageJoin(got, { dbFile }) {
  if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, `${dbFile}.before-join-${Date.now()}`)
  fs.writeFileSync(`${dbFile}.restored`, got.raw)
  const { stageVaultKey } = await import('../accountVault.js')
  const { restoreSecretBlobs } = await import('../secretStore.js')
  if (got.secrets.vault_key) stageVaultKey(got.secrets.vault_key)
  if (got.secrets.secrets) restoreSecretBlobs(got.secrets.secrets)
}
