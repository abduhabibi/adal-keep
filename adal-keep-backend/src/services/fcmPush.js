/**
 * fcmPush.js — instant "needs you" on the phones, also with Adal Keep swiped
 * away (Firebase Cloud Messaging, asked on 2026-11-19).
 *
 * The push carries no names or words: it only wakes the phone app, which then
 * reads the online copy of the "needs you" list with its own account and shows
 * the new ones (adal-phone AdalPushService → AdalNoticeJob.look). The phone's
 * job that looks every minute stays as the fallback (no Firebase, no Google
 * Play services, a push lost).
 *
 * The server key: a Firebase service account, in the backend .env only (never
 * committed): FCM_SERVICE_ACCOUNT = the JSON file's text, or the same in
 * base64, or FCM_SERVICE_ACCOUNT_FILE = its path. None set: nothing is sent.
 * The phones' push tokens: POST /api/mobile/push-token (settings "fcm_tokens";
 * "token" in the key keeps it out of the online copy).
 */
import crypto from 'crypto'
import fs from 'fs'

const KEY = 'fcm_tokens'
const MAX_TOKENS = 60

let account
function serviceAccount() {
  if (account !== undefined) return account
  account = null
  try {
    let raw = process.env.FCM_SERVICE_ACCOUNT || ''
    if (!raw && process.env.FCM_SERVICE_ACCOUNT_FILE) raw = fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8')
    raw = raw.trim()
    if (raw && !raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8')
    const a = raw ? JSON.parse(raw) : null
    if (a?.project_id && a?.client_email && a?.private_key) account = a
  } catch (e) { console.warn('[push] FCM_SERVICE_ACCOUNT is not a service account JSON:', e.message) }
  return account
}
export const pushReady = () => !!serviceAccount()

// For the tests: another account, another Google (a fake one).
let google = { token: 'https://oauth2.googleapis.com/token', fcm: 'https://fcm.googleapis.com' }
export function _testSetUp({ account: a, token, fcm } = {}) {
  account = a ?? undefined; access = null
  if (token) google.token = token
  if (fcm) google.fcm = fcm
}

let access = null   // { token, until }
async function accessToken() {
  if (access && access.until > Date.now()) return access.token
  const a = serviceAccount()
  const now = Math.floor(Date.now() / 1000)
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: a.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: a.token_uri || google.token, iat: now, exp: now + 3600 })}`
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(a.private_key).toString('base64url')
  const r = await fetch(google.token, {
    method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token) throw new Error(`Google sign-in ${r.status}: ${j.error_description || j.error || ''}`)
  access = { token: j.access_token, until: Date.now() + ((j.expires_in || 3600) - 300) * 1000 }
  return access.token
}

async function readTokens(db) {
  const row = await db('settings').where({ key: KEY }).first().catch(() => null)
  try { const t = JSON.parse(row?.value || '{}'); return t && typeof t === 'object' && !Array.isArray(t) ? t : {} } catch { return {} }
}
async function writeTokens(db, tokens) {
  const value = JSON.stringify(tokens)
  const n = await db('settings').where({ key: KEY }).update({ value })
  if (!n) await db('settings').insert({ key: KEY, value })
}

/** A phone's push token (new, or refreshed by Firebase). */
export async function savePushToken(db, token, device = '') {
  token = String(token || '').trim()
  if (!/^[\w:.-]{20,400}$/.test(token)) throw Object.assign(new Error('Not a push token'), { status: 400 })
  const tokens = await readTokens(db)
  tokens[token] = { at: new Date().toISOString(), device: String(device || '').slice(0, 80) }
  // The newest ones only (an old phone's token runs out by itself).
  const keep = Object.entries(tokens).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, MAX_TOKENS)
  await writeTokens(db, Object.fromEntries(keep))
}

/** One wake-up to every paired phone; tokens Firebase no longer knows are dropped. */
export async function pushToPhones(db, data = { type: 'attention' }) {
  if (!pushReady()) return { sent: 0, ready: false }
  const tokens = await readTokens(db)
  const list = Object.keys(tokens)
  if (!list.length) return { sent: 0, ready: true }
  const bearer = await accessToken()
  const a = serviceAccount()
  let sent = 0, gone = 0
  await Promise.all(list.map(async (token) => {
    try {
      const r = await fetch(`${google.fcm}/v1/projects/${encodeURIComponent(a.project_id)}/messages:send`, {
        method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
        // A data message, high priority: Android wakes the app even when it was swiped away.
        body: JSON.stringify({ message: { token, data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])), android: { priority: 'HIGH', ttl: '600s' } } }),
      })
      if (r.ok) { sent++; return }
      const j = await r.json().catch(() => ({}))
      const code = j?.error?.details?.find?.(d => d.errorCode)?.errorCode || j?.error?.status || ''
      if (r.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(code)) { delete tokens[token]; gone++ }
      else console.warn('[push] FCM', r.status, code)
    } catch (e) { console.warn('[push] FCM:', e.message) }
  }))
  if (gone) await writeTokens(db, tokens).catch(() => {})
  return { sent, gone, ready: true }
}

// The calls already pushed (run:title:at): a list that only lost one sends nothing.
let pushed = new Set()
let primed = false
/**
 * The "needs you" list just went online (cloudSync): a push when a new call
 * is in it (never at the first look after a start: those are old).
 */
export async function attentionOnline(db, list) {
  const keys = new Set((Array.isArray(list) ? list : [])
    .filter(c => Number(c?.run_id) > 0 && !(Number(c?.phone_wait_ms) > 0))
    .map(c => `${c.run_id}:${c.title || ''}:${c.at || 0}`))
  const fresh = [...keys].filter(k => !pushed.has(k))
  const first = !primed
  primed = true
  pushed = keys
  if (first || !fresh.length) return { sent: 0 }
  return pushToPhones(db, { type: 'attention' }).catch(e => { console.warn('[push]', e.message); return { sent: 0 } })
}
export function _testReset() { pushed = new Set(); primed = false }
