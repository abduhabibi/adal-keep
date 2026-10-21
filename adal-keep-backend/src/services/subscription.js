/**
 * subscription.js — 14-day trial, then locked until the PC is unlocked.
 *
 *   PC number   6 digits that belong to THIS server PC (from Windows'
 *               MachineGuid / Linux machine-id; the last digit is a check
 *               digit, so a number misheard on the phone is caught).
 *   Unlock      the customer calls Adal, says the PC number, and gets the
 *               current 6-digit Google Authenticator code for that PC.
 *               Each PC has its own Authenticator entry (its secret is
 *               HMAC(ADAL_LICENSE_KEY, PC number)), so a code only opens
 *               the PC it was made for. Unlocked once = unlocked for good.
 *   Locked      every /api call and every stored document is refused, and
 *               the background work stops. Nothing is encrypted or deleted.
 *
 * The seller makes the Authenticator entry with the private seller page
 * (seller/make-seller-page.mjs). ADAL_LICENSE_KEY must be the same in every
 * build: it is what both sides derive the per-PC secret from.
 *
 * State lives in two files (backend/.adal_sub.json and a copy outside the
 * install folder), so reinstalling does not restart the trial.
 */
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import dotenv from 'dotenv'
import { generateFingerprint } from './fingerprints.js'

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '../..')
const SIDE_PATH = path.join(ROOT, '.adal_sub.json')
const COPY_PATH = process.platform === 'win32'
  ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'AdalKeep', 'sub.json')
  : path.join(os.homedir(), '.config', 'adal-keep', 'sub.json')

export const TRIAL_DAYS = 14
export const SELLER_PHONE = process.env.ADAL_SELLER_PHONE || '0995668080'
const DAY = 86400000
const CLOCK_BACK_TOLERANCE = 6 * 3600000      // clock set back more than this → locked
const MAX_TRIES = 5                            // wrong codes allowed per 10 minutes
const TRY_WINDOW = 10 * 60000

const licenseKey = () => process.env.ADAL_LICENSE_KEY || ''

// ---------------------------------------------------------------------------
// PC number
// ---------------------------------------------------------------------------
function machineId() {
  try {
    if (process.platform === 'win32') {
      const out = execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid', { encoding: 'utf8', windowsHide: true })
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i)
      if (m) return m[1].toLowerCase()
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (fs.existsSync(f)) { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v }
      }
    }
  } catch {}
  return generateFingerprint()
}

/** Luhn check digit for a string of digits. */
export function luhnDigit(digits) {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9 }
    sum += d
  }
  return String((10 - (sum % 10)) % 10)
}

export const isPcNumber = (n) => /^\d{6}$/.test(String(n)) && luhnDigit(String(n).slice(0, 5)) === String(n)[5]

let _pc = null
export function pcNumber() {
  if (_pc) return _pc
  const h = crypto.createHash('sha256').update('adal-keep-pc:' + machineId()).digest()
  const five = String(h.readUInt32BE(0) % 100000).padStart(5, '0')
  return (_pc = five + luhnDigit(five))
}

// ---------------------------------------------------------------------------
// Google Authenticator (RFC 6238: SHA-1, 6 digits, 30 s)
// ---------------------------------------------------------------------------
export function pcSecret(pc, key = licenseKey()) {
  return crypto.createHmac('sha256', key).update('adal-keep-totp:' + pc).digest().subarray(0, 20)
}

export function totp(secret, step) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(step))
  const h = crypto.createHmac('sha1', secret).update(msg).digest()
  const o = h[19] & 15
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0')
}

/** A code from the last minute or the next 30 s is accepted (a phone call takes time). */
export function codeMatches(pc, code, now = Date.now(), key = licenseKey()) {
  if (!key || !/^\d{6}$/.test(code)) return false
  const secret = pcSecret(pc, key)
  const step = Math.floor(now / 30000)
  return [-2, -1, 0, 1].some(d => totp(secret, step + d) === code)
}

const proofFor = (pc) => crypto.createHmac('sha256', licenseKey() || 'no-key').update('adal-keep-unlocked:' + pc).digest('hex')

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
function readFile(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }

/** Both copies merged: the earliest trial start, the latest clock seen. */
export function readSide() {
  const a = readFile(SIDE_PATH), b = readFile(COPY_PATH)
  if (!a && !b) return null
  const s = { ...(b || {}), ...(a || {}) }
  const dates = [a?.installation_date, b?.installation_date].filter(Number.isFinite)
  if (dates.length) s.installation_date = Math.min(...dates)
  s.last_seen = Math.max(a?.last_seen || 0, b?.last_seen || 0) || null
  s.paid_until = Math.max(a?.paid_until || 0, b?.paid_until || 0) || null
  const pc = pcNumber()
  if ([a, b].some(x => x?.unlocked_pc === pc && x?.unlock_proof === proofFor(pc))) {
    const src = [a, b].find(x => x?.unlocked_pc === pc && x?.unlock_proof === proofFor(pc))
    Object.assign(s, { unlocked_pc: pc, unlock_proof: src.unlock_proof, unlocked_at: src.unlocked_at })
  }
  return s
}

export function writeSide(s) {
  for (const p of [SIDE_PATH, COPY_PATH]) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(s, null, 2)) } catch {}
  }
}

export function initSidecar() {
  const s = { installation_date: Date.now(), last_seen: Date.now(), paid_until: null }
  writeSide(s)
  return s
}

/** The state, created on first use: the trial starts the first time the server runs. */
function state() { return readSide() || initSidecar() }

let _lastTouch = 0
function touch(s) {
  const now = Date.now()
  if (now - _lastTouch < 10 * 60000 || now < (s.last_seen || 0)) return
  _lastTouch = now
  writeSide({ ...s, last_seen: now })
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------
/** 'active' (unlocked) · 'trial' · 'locked' */
export function computeMode(s) {
  if (!s) return 'trial'
  const now = Date.now()
  const pc = pcNumber()
  if (s.unlocked_pc === pc && s.unlock_proof === proofFor(pc)) return 'active'
  if (s.paid_until && s.paid_until > now) return 'active'   // paid with the old codes
  if (s.last_seen && now < s.last_seen - CLOCK_BACK_TOLERANCE) return 'locked'
  return now < s.installation_date + TRIAL_DAYS * DAY ? 'trial' : 'locked'
}

export function statusPayload(s = state()) {
  const mode = computeMode(s)
  const now = Date.now()
  const trialEnd = s ? s.installation_date + TRIAL_DAYS * DAY : null
  return {
    mode,
    daysLeft: mode === 'trial' && trialEnd ? Math.max(0, Math.ceil((trialEnd - now) / DAY)) : 0,
    trialDays: TRIAL_DAYS,
    trialEndsAt: trialEnd,
    pcNumber: pcNumber(),
    sellerPhone: SELLER_PHONE,
    clockBack: !!(mode === 'locked' && s?.last_seen && now < s.last_seen - CLOCK_BACK_TOLERANCE),
    unlockedAt: s?.unlocked_at || null,
    serverTime: now,
  }
}

let _cache = { at: 0, locked: false }
/** For background work: true while the trial is over and the PC is not unlocked. */
export function isAppLocked() {
  if (Date.now() - _cache.at > 30000) _cache = { at: Date.now(), locked: computeMode(readSide()) === 'locked' }
  return _cache.locked
}

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------
/** Returns { ok: true } or { ok: false, error }. */
export function applyCode(code) {
  const s = state()
  const now = Date.now()
  const tries = (s.tries || []).filter(t => now - t < TRY_WINDOW)
  if (tries.length >= MAX_TRIES) {
    const wait = Math.ceil((tries[0] + TRY_WINDOW - now) / 60000)
    return { ok: false, error: `Too many wrong codes. Wait ${wait} minute${wait > 1 ? 's' : ''} and try again.` }
  }
  if (!licenseKey()) return { ok: false, error: 'This installation has no licence key. Reinstall Adal Keep from the USB.' }
  const clean = String(code || '').replace(/\D/g, '')
  const pc = pcNumber()
  if (!codeMatches(pc, clean, now)) {
    writeSide({ ...s, tries: [...tries, now] })
    return { ok: false, error: 'That code is not right for this PC. Check the PC\'s date and time, then ask for a new code.' }
  }
  writeSide({ ...s, tries: [], unlocked_pc: pc, unlock_proof: proofFor(pc), unlocked_at: now, last_seen: now })
  _cache.at = 0
  return { ok: true }
}

/**
 * Adal approved this PC's payment receipt in the admin panel (read from the
 * chat server, where only Adal can approve): unlocked for good, as with a code.
 */
export function unlockApproved() {
  const s = state()
  const pc = pcNumber()
  if (computeMode(s) === 'active') return { ok: true }
  writeSide({ ...s, tries: [], unlocked_pc: pc, unlock_proof: proofFor(pc), unlocked_at: Date.now(), last_seen: Date.now(), unlocked_by: 'approval' })
  _cache.at = 0
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
const OPEN_WHEN_LOCKED = [
  ['GET', '/api/setup/status'],
  ['GET', '/api/subscription/status'],
  ['POST', '/api/subscription/unlock'],
  ['GET', '/api/health'],
  // The lock screen sends the payment receipt to Adal and waits for approval.
  ['POST', '/api/chat/unlock-request'],
  ['GET', '/api/chat/unlock-status'],
]

export function subscriptionGuard(req, res, next) {
  const p = req.path
  // The page itself (HTML, scripts, the lock screen's images) always loads.
  if (!p.startsWith('/api') && !p.startsWith('/uploads')) return next()
  const s = state()
  touch(s)
  if (computeMode(s) !== 'locked') return next()
  if (OPEN_WHEN_LOCKED.some(([m, q]) => req.method === m && p === q)) return next()
  return res.status(402).json({ error: 'locked', message: 'Adal Keep is locked. Unlock it to continue.' })
}

export async function maybeNotify(db, st) {
  if (!db || st.mode !== 'trial' || st.daysLeft > 3) return
  const today = new Date().toISOString().slice(0, 10)
  try {
    if (!(await db('notifications').where({ type: 'trial_warning', created_day: today }).first())) {
      await db('notifications').insert({
        type: 'trial_warning', title: 'Free trial ending soon',
        body: `Your ${TRIAL_DAYS}-day trial ends in ${st.daysLeft} day(s). Call ${SELLER_PHONE} and tell them PC number ${st.pcNumber} to get your unlock code.`,
        created_day: today, created_at: new Date().toISOString(),
      })
    }
  } catch {}
}
