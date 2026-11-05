/**
 * Portal passwords, locked in the database. Every account table's password and
 * the account a run carries are stored as "enc:v1:…" (AES-256-GCM), so the
 * database file alone gives nothing away.
 *
 * The code reads them as before: knexfile's postProcessResponse opens what comes
 * out of the database. sealStored() goes over the tables, so whatever was written
 * unlocked (an old install, a path not sealed by hand) is locked within a minute.
 *
 * The key is random, in data/account-vault.key: not tied to the PC's network
 * cards, which change. A backup carries it inside its locked index.
 */
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const KEY_FILE = process.env.ACCOUNT_VAULT_KEY || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'account-vault.key')
const MARK = 'enc:v1:'
const TABLES = ['musaned_accounts', 'lmis_accounts', 'visa_accounts', 'insurance_accounts', 'tasheer_accounts']

let key = null
function keyOf() {
  if (key) return key
  try { key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64') } catch {}
  if (key?.length !== 32) {
    key = crypto.randomBytes(32)
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true })
    fs.writeFileSync(KEY_FILE, key.toString('base64'), { mode: 0o600, flag: 'wx' })
  }
  return key
}

export const vaultKey = () => keyOf().toString('base64')

/**
 * A restored backup's key waits beside the restored database and goes in with it
 * on the next start: until then the current database still needs the current key.
 * A backup from before the vault has no key, and its passwords are not locked.
 */
export function stageVaultKey(b64) {
  const k = Buffer.from(String(b64 || ''), 'base64')
  fs.rmSync(`${KEY_FILE}.restored`, { force: true })
  if (k.length === 32) fs.writeFileSync(`${KEY_FILE}.restored`, k.toString('base64'), { mode: 0o600 })
}

/** The old key stays, for the database kept as data.sqlite.before-restore-<time>. */
export function applyStagedVaultKey() {
  if (!fs.existsSync(`${KEY_FILE}.restored`)) return
  if (fs.existsSync(KEY_FILE)) fs.copyFileSync(KEY_FILE, `${KEY_FILE}.before-restore-${Date.now()}`)
  fs.renameSync(`${KEY_FILE}.restored`, KEY_FILE)
  key = null
}

export function seal(text) {
  if (text == null || text === '' || String(text).startsWith(MARK)) return text
  const iv = crypto.randomBytes(12)
  const c = crypto.createCipheriv('aes-256-gcm', keyOf(), iv)
  const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()])
  return MARK + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64')
}

export function open(value) {
  if (typeof value !== 'string' || !value.startsWith(MARK)) return value
  try {
    const b = Buffer.from(value.slice(MARK.length), 'base64')
    const d = crypto.createDecipheriv('aes-256-gcm', keyOf(), b.subarray(0, 12))
    d.setAuthTag(b.subarray(12, 28))
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
  } catch (e) {
    console.warn('[vault] could not open a password (is data/account-vault.key the right one?):', e.message)
    return ''
  }
}

function openRow(r) {
  if (r && typeof r === 'object') for (const k of ['password', 'context']) if (typeof r[k] === 'string' && r[k].startsWith(MARK)) r[k] = open(r[k])
  return r
}

/** knex: everything read from the database comes out open. */
export function openRows(result) {
  if (Array.isArray(result)) result.forEach(openRow)
  else openRow(result)
  return result
}

/** Locks whatever is still open. knex opens every answer, so the SQL picks the unlocked rows. */
export async function sealStored(db) {
  let n = 0
  for (const t of TABLES) {
    if (!(await db.schema.hasTable(t))) continue
    const { rows } = await raw(db, `select id, password from ${t} where password is not null and password <> '' and password not like '${MARK}%'`)
    for (const r of rows) { await raw(db, `update ${t} set password = ? where id = ?`, [seal(r.password), r.id]); n++ }
  }
  const { rows } = await raw(db, `select id, context from automation_queue where context like '%password%' and context not like '${MARK}%'`)
  for (const r of rows) { await raw(db, 'update automation_queue set context = ? where id = ?', [seal(r.context), r.id]); n++ }
  if (n) {
    console.log(`[vault] ${n} password record(s) locked`)
    await wipeFreedPages(db)
  }
  return n
}
// SQLite leaves replaced text in the file's free pages: rebuild it so the open
// passwords are really gone, not only out of the tables.
async function wipeFreedPages(db) {
  try {
    await db.raw('VACUUM')
    await db.raw('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch (e) { console.warn('[vault] database not rebuilt yet:', e.message) }
}
const raw = async (db, sql, args = []) => {
  const rows = await db.raw(sql, args)
  return { rows: Array.isArray(rows) ? rows : [] }
}
