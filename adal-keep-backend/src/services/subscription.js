import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { generateFingerprint } from './fingerprints.js'
import dotenv from 'dotenv'

dotenv.config()   // load .env

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '../..')
const DB_PATH = path.join(ROOT, 'data.sqlite')
const LOCK_PATH = DB_PATH + '.adal'
const SIDE_PATH = path.join(ROOT, '.adal_sub.json')

const CODE_SECRET = process.env.CODE_SECRET || 'adal-keep-code-signing-secret-v1'
const MASTER_CODE = process.env.DEV_MASTER_PASSWORD   // ← comes from .env / environment
const TRIAL_DAYS = 7
const DESTROY_DAYS = 180
const DAY = 86400000

export const isLockedFile = () => fs.existsSync(LOCK_PATH)
export function readSide() { try { return JSON.parse(fs.readFileSync(SIDE_PATH, 'utf8')) } catch { return null } }
export function writeSide(s) { fs.writeFileSync(SIDE_PATH, JSON.stringify(s, null, 2)) }
export function initSidecar() { const s = { installation_date: Date.now(), paid_until: null, last_seen: Date.now() }; writeSide(s); return s }

function deriveKey() {
  return crypto.createHash('sha256').update(CODE_SECRET + ':' + generateFingerprint()).digest()
}

export async function encryptDatabase() {
  if (!fs.existsSync(DB_PATH)) return
  const key = deriveKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(fs.readFileSync(DB_PATH)), cipher.final()])
  fs.writeFileSync(LOCK_PATH, Buffer.concat([iv, cipher.getAuthTag(), enc]))
  fs.unlinkSync(DB_PATH)
}

export async function decryptDatabase() {
  if (!fs.existsSync(LOCK_PATH)) return
  const key = deriveKey()
  const blob = fs.readFileSync(LOCK_PATH)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12))
  decipher.setAuthTag(blob.subarray(12, 28))
  fs.writeFileSync(DB_PATH, Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]))
  fs.unlinkSync(LOCK_PATH)
}

export function computeMode(s) {
  if (!s) return 'fresh'
  if (isLockedFile()) return 'destroyed'
  const now = Date.now()
  const effectiveEnd = Math.max(s.paid_until || 0, s.installation_date + TRIAL_DAYS * DAY)
  if (now > s.installation_date + DESTROY_DAYS * DAY && now > effectiveEnd) return 'destroyed_due'
  if (now > effectiveEnd) return 'read_only'
  return (s.paid_until && s.paid_until > now) ? 'active' : 'trial'
}

export function statusPayload(s) {
  const mode = computeMode(s)
  const effectiveEnd = s ? Math.max(s.paid_until || 0, s.installation_date + TRIAL_DAYS * DAY) : null
  return {
    mode,
    daysLeft: effectiveEnd ? Math.ceil((effectiveEnd - Date.now()) / DAY) : null,
    paidUntil: s?.paid_until || null,
    installationDate: s?.installation_date || null,
  }
}

export async function preCheck() {
  const s = readSide()
  if (!s) return 'fresh'
  const mode = computeMode(s)
  if (mode === 'destroyed_due') { await encryptDatabase(); return 'destroyed' }
  return mode
}

/**
 * verifyCode – only accepts the master code that lives in the environment.
 * No password is hard-coded in the source.
 */
function verifyCode(code) {
  if (!code || typeof code !== 'string') return null
  const cleaned = code.trim()

  // Master code must come from environment variable
  if (MASTER_CODE && cleaned === MASTER_CODE) {
    return { days: 365, exp: Date.now() + 365 * DAY }
  }

  // Placeholder for future signed codes
  return null
}

export function applyCode(code) {
  const v = verifyCode(code)
  if (!v) return false
  let s = readSide() || initSidecar()
  s.paid_until = Date.now() + v.days * DAY
  s.last_seen = Date.now()
  writeSide(s)
  return true
}

export function subscriptionGuard(req, res, next) {
  const s = readSide()
  const mode = computeMode(s)
  const p = req.path
  if (mode === 'destroyed' || mode === 'destroyed_due') {
    const allowed =
      (req.method === 'GET' && (p.startsWith('/api/setup') || p === '/api/subscription/status')) ||
      (req.method === 'POST' && p === '/api/subscription/unlock')
    return allowed ? next() : res.status(403).json({ error: 'System locked. Enter your access code.' })
  }
  if (mode === 'read_only') {
    const allowed =
      req.method === 'GET' ||
      p.startsWith('/api/subscription') || p.startsWith('/api/license') || p.startsWith('/api/setup') ||
      (p.startsWith('/api/notifications') && req.method === 'DELETE')
    return allowed ? next() : res.status(403).json({ error: 'Subscription expired — read-only mode. Enter access code to continue.' })
  }
  next()
}

export async function maybeNotify(db, st) {
  if (!db) return
  const today = new Date().toISOString().slice(0, 10)
  try {
    if (st.mode === 'trial' && st.daysLeft <= 3) {
      if (!(await db('notifications').where({ type: 'trial_warning', created_day: today }).first()))
        await db('notifications').insert({ type: 'trial_warning', title: 'Subscription ending soon', body: `Your free trial ends in ${st.daysLeft} day(s). Contact your provider to get an access code.`, created_day: today, created_at: new Date().toISOString() })
    }
    if (st.mode === 'read_only') {
      if (!(await db('notifications').where({ type: 'trial_expired', created_day: today }).first()))
        await db('notifications').insert({ type: 'trial_expired', title: 'Subscription expired', body: 'The system is in read-only mode. Enter your access code in Settings to restore full access.', created_day: today, created_at: new Date().toISOString() })
    }
  } catch {}
}
