/**
 * subscription.js — 3-week (21-day) trial, then locked until the PC is unlocked.
 *
 *   PC number   6 digits that belong to THIS server PC (from Windows'
 *               MachineGuid / Linux machine-id; the last digit is a check
 *               digit, so a number misheard on the phone is caught).
 *   Unlock      the customer calls Adal, says the PC number, and gets the
 *               current 6-digit Google Authenticator code for that PC.
 *               Each PC has its own Authenticator entry (its secret is
 *               HMAC(ADAL_LICENSE_KEY, PC number)), so a code only opens
 *               the PC it was made for. A code pays 6 months (30,000 ETB,
 *               since 2026-11-03): the PC is open until then, and the next
 *               code adds 6 more months. PCs unlocked "for good" before that
 *               (50,000 ETB) stay open.
 *   Locked      every /api call and every stored document is refused, and
 *               the background work stops. Nothing is encrypted or deleted.
 *   Suspended   Adal suspended the PC in Adal Keep Admin (signed licence,
 *               plans.js): locked the same way, with a "suspended" screen,
 *               until Admin allows it again. Codes still add paid months.
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
import { licenseNow } from './plans.js'

// Adal's signed licence (plans.js): paid until / a longer trial, given in the admin panel.
const licPaid = () => Number(licenseNow()?.paid_until) || 0
// Adal suspended this PC (Admin → Suspend): locked until Admin allows it again, whatever is paid.
const suspension = () => licenseNow()?.suspended || null
const trialEnd = (s) => Math.max((s?.installation_date || trustedNow()) + TRIAL_DAYS * DAY, Number(licenseNow()?.trial_until) || 0)

dotenv.config()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '../..')
const SIDE_PATH = path.join(ROOT, '.adal_sub.json')
const COPY_PATH = process.platform === 'win32'
  ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'AdalKeep', 'sub.json')
  : path.join(os.homedir(), '.config', 'adal-keep', 'sub.json')

export const TRIAL_DAYS = 21   // 3 weeks
export const PAID_DAYS = 182            // one code = 6 months
export const PRICE_ETB = 30000          // for those 6 months
export const SELLER_PHONE = process.env.ADAL_SELLER_PHONE || '0995668080'
const DAY = 86400000
const MAX_TRIES = 5                            // wrong codes allowed per 10 minutes
const TRY_WINDOW = 10 * 60000

const licenseKey = () => process.env.ADAL_LICENSE_KEY || ''

// ---------------------------------------------------------------------------
// The time: from the internet, never the PC's clock alone
// ---------------------------------------------------------------------------
// A PC's clock is often wrong (Nuzla's was a day ahead, then put right — and
// "the clock was set back" locked the PC). The PC is never locked for its
// clock now. Adal Keep asks the internet for the time (every hour) and keeps
// how far the PC's clock is off; the trial and the paid days count with that.
// With no internet: the PC's clock, never earlier than the last time seen —
// setting the clock back gains no days, and locks nothing.
let clock = { offset: 0, at: 0 }   // offset: internet time − PC clock; at: when last asked (internet time)
let clockLoaded = false, clockAsking = null, clockAskedAt = 0
function loadClock() {
  if (clockLoaded) return
  clockLoaded = true
  for (const p of [SIDE_PATH, COPY_PATH]) {
    const c = readFile(p)?.clock
    if (Number.isFinite(c?.offset) && Number.isFinite(c?.at) && c.at > clock.at) clock = { offset: c.offset, at: c.at }
  }
}
/** The time now: the PC's clock put right by the last internet time. */
export function trustedNow() { loadClock(); return Date.now() + clock.offset }
/** Internet time was seen in the last 3 days: the time is sure. */
const clockSure = () => clock.at > 0 && Math.abs(trustedNow() - clock.at) < 3 * DAY
/** The time the trial and the paid days count with. */
export function effectiveNow(s) {
  const t = trustedNow()
  return clockSure() ? t : Math.max(t, s?.last_seen || 0)
}

/** Internet time from an answer's Date header (Adal's cloud, else Google / Cloudflare). */
export async function askInternetTime(fetchImpl = fetch) {
  const urls = [process.env.SUPABASE_URL, 'https://www.google.com', 'https://www.cloudflare.com'].filter(Boolean)
  for (const u of urls) {
    try {
      const t0 = Date.now()
      const r = await fetchImpl(u, { method: 'HEAD', signal: AbortSignal.timeout(8000) })
      const t1 = Date.now()
      const net = Date.parse(r.headers.get('date') || '')
      if (Number.isFinite(net)) return { offset: Math.round(net + 500 - (t0 + t1) / 2), at: net }   // the header drops the ms: +0.5 s
    } catch {}
  }
  return null
}
/** Asks the internet for the time at most once an hour (in the background); keeps the answer. */
export function syncClock({ force = false } = {}) {
  loadClock()
  if (process.env.NODE_TEST_CONTEXT && !force) return null   // (tests never ask the real internet)
  if (clockAsking || (!force && Date.now() - clockAskedAt < 3600000)) return clockAsking
  clockAskedAt = Date.now()
  clockAsking = askInternetTime().then(c => {
    if (!c) return null
    // Under 2 minutes off: the PC's clock is right (no jitter in the counts).
    clock = { offset: Math.abs(c.offset) < 120000 ? 0 : c.offset, at: c.at }
    const st = readSide()
    if (st) {
      // A last-seen time from a clock that was ahead is put right.
      if (st.last_seen && st.last_seen > c.at + 6 * 3600000) st.last_seen = c.at
      writeSide({ ...st, clock })
    }
    if (clock.offset) {
      console.log(`[clock] this PC's clock is ${Math.round(clock.offset / 60000)} min off — Adal Keep uses internet time`)
      fixWindowsClock()
    }
    return clock
  }).catch(() => null).finally(() => { clockAsking = null })
  return clockAsking
}
/** Asks Windows to set its clock from the internet (works where Windows allows it; nothing breaks if not). */
function fixWindowsClock() {
  if (process.platform !== 'win32') return
  import('child_process').then(({ exec }) => exec('w32tm /resync /nowait', { windowsHide: true, timeout: 15000 }, () => {})).catch(() => {})
}

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
export function codeMatches(pc, code, now = trustedNow(), key = licenseKey()) {
  if (!key || !/^\d{6}$/.test(code)) return false
  const secret = pcSecret(pc, key)
  const step = Math.floor(now / 30000)
  return [-2, -1, 0, 1].some(d => totp(secret, step + d) === code)
}

// Unlocked for good (sold before 2026-11-03).
const proofFor = (pc) => crypto.createHmac('sha256', licenseKey() || 'no-key').update('adal-keep-unlocked:' + pc).digest('hex')
// Paid until a date: the date is signed, so editing the file does not move it.
export const paidProof = (pc, until) => crypto.createHmac('sha256', licenseKey() || 'no-key').update(`adal-keep-paid:${pc}:${until}`).digest('hex')
const paidOk = (x, pc) => !!(x?.paid_until && x?.paid_proof && x.paid_proof === paidProof(pc, x.paid_until))

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
  const pc = pcNumber()
  // A "paid until" from before the date was signed (the old codes): signed now, once.
  for (const x of [a, b]) if (x?.paid_until && !x.paid_proof) x.paid_proof = paidProof(pc, x.paid_until)
  // The latest signed "paid until" of the two copies.
  const paid = [a, b].filter(x => paidOk(x, pc)).sort((x, y) => y.paid_until - x.paid_until)[0]
  s.paid_until = paid?.paid_until || null
  s.paid_proof = paid?.paid_proof || null
  if ([a, b].some(x => x?.unlocked_pc === pc && x?.unlock_proof === proofFor(pc))) {
    const src = [a, b].find(x => x?.unlocked_pc === pc && x?.unlock_proof === proofFor(pc))
    Object.assign(s, { unlocked_pc: pc, unlock_proof: src.unlock_proof, unlocked_at: src.unlocked_at })
  }
  return s
}

export function writeSide(s) {
  // Never lose a paid date that is on file (a write from an older read).
  const pc = pcNumber()
  for (const x of [readFile(SIDE_PATH), readFile(COPY_PATH)]) {
    if (x?.paid_until && (!x.paid_proof || paidOk(x, pc)) && x.paid_until > (s.paid_until || 0)) {
      s = { ...s, paid_until: x.paid_until, paid_proof: paidProof(pc, x.paid_until) }
    }
    if (x?.unlocked_pc === pc && x?.unlock_proof === proofFor(pc) && s.unlock_proof !== x.unlock_proof) {
      s = { ...s, unlocked_pc: pc, unlock_proof: x.unlock_proof, unlocked_at: x.unlocked_at }
    }
  }
  for (const p of [SIDE_PATH, COPY_PATH]) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(s, null, 2)) } catch {}
  }
}

export function initSidecar() {
  const s = { installation_date: trustedNow(), last_seen: trustedNow(), paid_until: null }
  writeSide(s)
  return s
}

/** The state, created on first use: the trial starts the first time the server runs. */
function state() { return readSide() || initSidecar() }

let _lastTouch = 0
function touch(s) {
  const now = trustedNow()
  if (Math.abs(now - _lastTouch) < 10 * 60000 || (now < (s.last_seen || 0) && !clockSure())) return
  _lastTouch = now
  writeSide({ ...s, last_seen: now })
}

// ---------------------------------------------------------------------------
// Mode
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// A Companion with its own copy (docs/companion-full.md): the agency's licence
// is the main PC's. The main PC writes its state for every PC (signed with
// ADAL_LICENSE_KEY, services/sync/roles.js); a Companion opens while that is
// paid or in its trial, and locks or shows "suspended" with it. Codes are
// typed on the main PC (they are made for its PC number).
// ---------------------------------------------------------------------------
let follow = null
export function followAgencyLicence(fn) { follow = fn; _cache.at = 0 }
export const followsAgency = () => !!follow
/** Until when this PC itself is paid (its code, or Adal's signed licence); 0: not. */
function ownPaid() {
  const s = readSide(), pc = pcNumber()
  if (s?.unlocked_pc === pc && s?.unlock_proof === proofFor(pc)) return Infinity
  return Math.max(s && paidOk(s, pc) ? s.paid_until : 0, licPaid())
}
function followed() {
  let f = null
  try { f = follow?.() } catch {}
  const l = f?.licence || null
  const now = trustedNow()
  const cut = f?.cutOff || null
  let mode
  if (cut || l?.suspended) mode = 'locked'
  else if (!l) mode = 'trial'                       // (no word from the main PC yet: it let this PC in)
  else if (l.forGood || (l.paidUntil && l.paidUntil > now)) mode = 'active'
  else if (l.mode === 'trial' && l.trialEndsAt && l.trialEndsAt > now) mode = 'trial'
  else mode = 'locked'
  // This PC is paid for itself: the main PC's own trial (a PC standing in for it) never locks it (Nuzla, 2026-11-25).
  if (mode === 'locked' && !cut && !l?.suspended && !suspension() && ownPaid() > now) mode = 'active'
  return { mode, l, now, cut }
}

/** 'active' (unlocked) · 'trial' · 'locked' */
export function computeMode(s) {
  syncClock()
  if (follow) return followed().mode
  if (suspension()) return 'locked'
  if (!s) return 'trial'
  const now = effectiveNow(s)
  const pc = pcNumber()
  if (s.unlocked_pc === pc && s.unlock_proof === proofFor(pc)) return 'active'
  if (paidOk(s, pc) && s.paid_until > now) return 'active'
  if (licPaid() > now) return 'active'
  return now < trialEnd(s) ? 'trial' : 'locked'
}

export function statusPayload(s = state()) {
  if (follow) {
    const { mode, l, now, cut } = followed()
    return {
      mode, followsMain: true,
      daysLeft: mode === 'trial' && l?.trialEndsAt ? Math.max(0, Math.ceil((l.trialEndsAt - now) / DAY)) : 0,
      trialDays: TRIAL_DAYS, trialEndsAt: l?.trialEndsAt || null, pcNumber: l?.pcNumber || null, sellerPhone: SELLER_PHONE,
      clockBack: false, unlockedAt: null, forGood: !!l?.forGood, paidUntil: l?.paidUntil || null,
      paidDaysLeft: l?.paidUntil ? Math.max(0, Math.ceil((l.paidUntil - now) / DAY)) : 0, priceEtb: PRICE_ETB, paidMonths: 6, serverTime: now,
      suspended: !!(cut === 'suspended' || l?.suspended), suspendedAt: l?.suspendedAt || null,
      suspendNote: cut ? `This PC was ${cut} by the main PC.` : (l?.suspendNote || ''),
    }
  }
  const mode = computeMode(s)
  const now = effectiveNow(s)
  const trialEndsAt = s ? trialEnd(s) : null
  return {
    mode,
    daysLeft: mode === 'trial' && trialEndsAt ? Math.max(0, Math.ceil((trialEndsAt - now) / DAY)) : 0,
    trialDays: TRIAL_DAYS,
    trialEndsAt,
    pcNumber: pcNumber(),
    sellerPhone: SELLER_PHONE,
    clockBack: false,   // never locked for the clock any more (internet time is used)
    unlockedAt: s?.unlocked_at || null,
    forGood: !!(s?.unlocked_pc === pcNumber() && s?.unlock_proof === proofFor(pcNumber())),
    paidUntil: Math.max(s && paidOk(s, pcNumber()) ? s.paid_until : 0, licPaid()) || null,
    paidDaysLeft: Math.max(0, Math.ceil((Math.max(s && paidOk(s, pcNumber()) ? s.paid_until : 0, licPaid()) - now) / DAY)),
    priceEtb: PRICE_ETB,
    paidMonths: 6,
    serverTime: now,
    suspended: !!suspension(),
    suspendedAt: suspension()?.at || null,
    suspendNote: suspension()?.note || '',
  }
}

let _cache = { at: 0, locked: false }
/** A new licence from Adal (plans.js): background work sees it at once, not in 30 s. */
export function licenseChanged() { _cache.at = 0 }
/** For background work: true while the trial is over and the PC is not unlocked. */
export function isAppLocked() {
  if (Date.now() - _cache.at > 30000) _cache = { at: Date.now(), locked: computeMode(readSide()) === 'locked' }
  return _cache.locked
}

// ---------------------------------------------------------------------------
// Unlock
// ---------------------------------------------------------------------------
/** 6 more months, from today or from the end of what is paid already. */
function extend(s, pc, now, by) {
  const from = paidOk(s, pc) && s.paid_until > now ? s.paid_until : now
  const until = from + PAID_DAYS * DAY
  return { ...s, paid_until: until, paid_proof: paidProof(pc, until), unlocked_at: now, unlocked_by: by, last_seen: now }
}

/** Returns { ok: true } or { ok: false, error }. */
export function applyCode(code) {
  if (follow) return { ok: false, error: 'This PC follows the main PC\'s licence: type the code on the main PC.' }
  const s = state()
  const now = trustedNow()
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
  // A code counts once (it stays good for about 2 minutes: typed twice it would pay twice).
  const used = (s.used_codes || []).filter(u => now - u.at < 10 * 60000)
  if (used.some(u => u.code === crypto.createHash('sha256').update(pc + clean).digest('hex'))) {
    return { ok: false, error: 'This code was used already. Ask Adal for a new code.' }
  }
  writeSide({ ...extend(s, pc, now, 'code'), tries: [], used_codes: [...used, { at: now, code: crypto.createHash('sha256').update(pc + clean).digest('hex') }] })
  _cache.at = 0
  return { ok: true, paidUntil: readSide()?.paid_until || null }
}

/**
 * Adal approved this PC's payment receipt in the admin panel (read from the
 * chat server, where only Adal can approve): unlocked for good, as with a code.
 */
export function unlockApproved() {
  const s = state()
  const pc = pcNumber()
  // Suspended: an approval adds nothing now (it would add 6 months at every check).
  if (suspension()) return { ok: false, suspended: true }
  if (computeMode(s) === 'active') return { ok: true }
  writeSide({ ...extend(s, pc, trustedNow(), 'approval'), tries: [] })
  _cache.at = 0
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------
const OPEN_WHEN_LOCKED = [
  ['GET', '/api/setup/status'],
  ['GET', '/api/subscription/status'],
  ['GET', '/api/subscription/billing'],
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
  if (follow ? statusPayload(s).suspended : suspension()) return res.status(402).json({ error: 'locked', suspended: true, message: 'Adal Keep is suspended on this PC by Adal. Call Adal to have it allowed again.' })
  return res.status(402).json({ error: 'locked', message: 'Adal Keep is locked. Unlock it to continue.' })
}

export async function maybeNotify(db, st) {
  if (!db) return
  const today = new Date().toISOString().slice(0, 10)
  // The 6 paid months end in 14 days or less: a reminder a day.
  if (st.mode === 'active' && st.paidUntil && st.paidDaysLeft <= 14) {
    try {
      if (!(await db('notifications').where({ type: 'trial_warning', created_day: today }).first())) {
        await db('notifications').insert({
          type: 'trial_warning', title: 'Adal Keep: time to renew',
          body: `The paid 6 months end in ${st.paidDaysLeft} day(s) (${new Date(st.paidUntil).toLocaleDateString('en-GB')}). Pay ${PRICE_ETB.toLocaleString('en')} ETB for 6 more months: call ${SELLER_PHONE} and tell them PC number ${st.pcNumber} for the code.`,
          created_day: today, created_at: new Date().toISOString(),
        })
      }
    } catch {}
    return
  }
  if (st.mode !== 'trial' || st.daysLeft > 3) return
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
