/**
 * Jev client — TypeSafe's System One decision model.
 *
 * Reads TYPESAFE_API_KEY from env (or the encrypted secret store).
 * Never throws into the caller's hot path — on failure returns
 * { ok: false, reason } so workflows can fall back safely.
 */

import { getSecret } from '../secretStore.js'

let _client = null
let _sdk = null

function getKey() {
  return (
    getSecret('TYPESAFE_API_KEY') ||
    process.env.TYPESAFE_API_KEY ||
    ''
  )
}

export function isEnabled() {
  if (String(process.env.JEV_ENABLED || '').toLowerCase() === 'false') return false
  return !!getKey()
}

async function loadSdk() {
  if (_sdk) return _sdk
  _sdk = await import('@typesafe-ai/sdk')
  return _sdk
}

async function getClient() {
  if (_client) return _client
  const sdk = await loadSdk()
  _client = new sdk.TypeSafeClient({
    apiKey: getKey(),
    model: process.env.JEV_MODEL || 'jev-1.13.0',
  })
  return _client
}

/**
 * Send a state object + typed questions. Returns:
 *   { ok: true,  answers: { qname: {...} }, raw }
 *   { ok: false, reason: 'disabled'|'error', error }
 */
export async function askJev(state, questions, { timeoutMs = 10000 } = {}) {
  if (!isEnabled()) return { ok: false, reason: 'disabled' }
  try {
    const client = await getClient()
    const call = client.system_one(state, questions)
    const raw = await Promise.race([
      call,
      new Promise((_, rej) => setTimeout(() => rej(new Error('jev_timeout')), timeoutMs)),
    ])
    return { ok: true, answers: raw?.answers || raw || {}, raw }
  } catch (e) {
    console.warn('[jev] ask failed:', e.message)
    return { ok: false, reason: 'error', error: e.message }
  }
}