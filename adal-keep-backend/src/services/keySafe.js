/**
 * keySafe.js — the agency's keys are never lost ("keep the key in Supabase,
 * Telegram, every PC connected to the main, and the main PC itself … we
 * shouldn't lose any data in any way", 2026-11-20).
 *
 * Two keys matter:
 *   • the vault key (data/account-vault.key) opens the portal passwords in the
 *     database. Copies: the main PC; a second copy outside the install folder
 *     (%LOCALAPPDATA%\AdalKeep\keys, survives an uninstall); every Telegram
 *     backup; every Companion's copy (replica keys); Supabase (keep_meta
 *     '/_keys', locked with the documents' key — cloudSync.pushVaultKey).
 *   • the documents' key (Supabase keep_secrets.file_key) opens every document
 *     in Telegram. Copies: Supabase; the main PC's locked secrets (so also every
 *     Telegram backup and every Companion, which carry those secrets).
 *     cloudSync.agencySecrets never makes a new one while a kept one exists.
 *
 * A PC whose vault key is gone or wrong (its passwords do not open): the first
 * copy that opens them is put back, and the one that was there is kept beside.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { getSecret, setSecret } from './secretStore.js'

const MARK = 'enc:v1:'
const DATA = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data')
export const OUTSIDE = process.env.ADAL_KEYS_OUTSIDE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'AdalKeep', 'keys')
const name = (agency) => `docs_file_key:${agency}`

// ── the documents' key ──────────────────────────────────────────────────────
export function keptFileKey(agency) {
  try { return getSecret(name(agency)) || null } catch { return null }
}

/** Kept locked on this PC; a different one before it is kept too, never dropped. */
export function keepFileKey(agency, key) {
  if (!agency || !key) return
  try {
    const old = keptFileKey(agency)
    if (old === key) return
    if (old) setSecret(`docs_file_key_before:${agency}:${Date.now()}`, old)
    setSecret(name(agency), key)
  } catch (e) { console.warn('[keys] documents key not kept here:', e.message) }
}

// ── the vault key ───────────────────────────────────────────────────────────
const fp = (b64) => crypto.createHash('sha256').update(String(b64)).digest('hex').slice(0, 12)

/** A copy of this vault key outside the install folder (one file per key, none removed). */
export function copyVaultKeyOutside(b64) {
  if (!b64) return null
  try {
    fs.mkdirSync(OUTSIDE, { recursive: true })
    const f = path.join(OUTSIDE, `account-vault.${fp(b64)}.key`)
    if (!fs.existsSync(f)) fs.writeFileSync(f, b64, { mode: 0o600 })
    return f
  } catch (e) { console.warn('[keys] no copy outside the install folder:', e.message); return null }
}

export function outsideKeys() {
  try {
    return fs.readdirSync(OUTSIDE).filter(f => /^account-vault\.[0-9a-f]{12}\.key$/.test(f))
      .map(f => fs.readFileSync(path.join(OUTSIDE, f), 'utf8').trim()).filter(Boolean)
  } catch { return [] }
}

/** Does this key open the sealed value? */
export function opensWith(sealed, b64) {
  try {
    const k = Buffer.from(String(b64), 'base64')
    if (k.length !== 32 || !String(sealed).startsWith(MARK)) return false
    const b = Buffer.from(String(sealed).slice(MARK.length), 'base64')
    const d = crypto.createDecipheriv('aes-256-gcm', k, b.subarray(0, 12))
    d.setAuthTag(b.subarray(12, 28))
    Buffer.concat([d.update(b.subarray(28)), d.final()])
    return true
  } catch { return false }
}

/** Some sealed passwords of this database (raw, not opened by knex). */
async function sealedSamples(db, n = 3) {
  const out = []
  for (const t of ['musaned_accounts', 'lmis_accounts', 'visa_accounts', 'insurance_accounts', 'tasheer_accounts']) {
    try {
      if (!(await db.schema.hasTable(t))) continue
      const rows = await db.raw(`select password as sealed_value from ${t} where password like '${MARK}%' limit ${n}`)
      for (const r of Array.isArray(rows) ? rows : []) if (r.sealed_value) out.push(r.sealed_value)
    } catch {}
    if (out.length >= n) break
  }
  return out
}

/** The vault key Supabase keeps ('/_keys', locked with the documents' key), or null. */
async function onlineVaultKey(db) {
  try {
    const { cloudCall, cloudAgencyId } = await import('./chatCloud.js')
    const agency = await cloudAgencyId(db)
    if (!agency) return null
    const [row] = await cloudCall(db, 'GET', `/rest/v1/keep_meta?agency_id=eq.${agency}&key=eq./_keys&select=data`)
    if (!row?.data?.v) return null
    const fileKey = keptFileKey(agency) || (await (await import('./cloudSync.js')).agencySecrets(db, agency))?.file_key
    const { decrypt } = await import('./tgStore.js')
    return JSON.parse(decrypt(Buffer.from(row.data.v, 'base64'), fileKey).toString('utf8'))?.vault_key || null
  } catch { return null }
}

/**
 * After each start: the vault key copied outside, and — when this database's
 * passwords do not open with the key here — the first copy that opens them is
 * put back (the one that was there kept as account-vault.key.before-restore-…).
 * Returns 'ok' | 'none' (nothing sealed) | 'restored:<where>' | 'missing'.
 */
export async function guardVaultKey(db, { online = onlineVaultKey } = {}) {
  const V = await import('./accountVault.js')
  const here = V.vaultKey()
  copyVaultKeyOutside(here)
  const samples = await sealedSamples(db)
  if (!samples.length) return 'none'
  const opensAll = (k) => samples.every(s => opensWith(s, k))
  if (opensAll(here)) return 'ok'
  const tries = [...outsideKeys().map(k => ['this PC (outside the install folder)', k])]
  const o = await online(db).catch(() => null)
  if (o) tries.push(['Supabase', o])
  for (const [where, k] of tries) {
    if (k === here || !opensAll(k)) continue
    V.stageVaultKey(k)
    V.applyStagedVaultKey()
    copyVaultKeyOutside(k)
    console.log(`[keys] the portal passwords' key was wrong on this PC — put back from ${where}`)
    return `restored:${where}`
  }
  console.warn('[keys] the portal passwords do not open with any kept key (restore a backup in Settings → Backup)')
  return 'missing'
}
