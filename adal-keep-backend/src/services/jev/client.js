/**
 * Jev client — TypeSafe's System One decision model (SDK 0.7, `systemOne`).
 *
 * Reads TYPESAFE_API_KEY from env (or the encrypted secret store).
 * Never throws into the caller's hot path — on failure returns
 * { ok: false, reason } so workflows can fall back safely.
 *
 * The callers in this folder were written for an older SDK and send
 *   { type: 'Choice', options: [...], instructions }   or   { type: 'Noul', instructions }
 * askJev() translates those to the SDK's question format, so callers keep
 * their simple shape and keep reading `answers.<name>.choice` / `.noul`.
 */

import { getSecret } from '../secretStore.js'

let _client = null
// No credits / bad key: stop calling for a while instead of failing every step.
let _pausedUntil = 0
let _pauseReason = ''

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

async function getClient() {
  if (_client) return _client
  const sdk = await import('@typesafe-ai/sdk')
  _client = new sdk.TypeSafeClient({
    apiKey: getKey(),
    defaultModel: process.env.JEV_MODEL || undefined,
    retry: { maxRetries: 1 },
  })
  return _client
}

/** Old-style questions → SDK questions (choice / noul / score / box). */
export function toSdkQuestions(questions) {
  const out = {}
  for (const [name, q] of Object.entries(questions || {})) {
    const type = String(q?.type || '').toLowerCase()
    const instructions = q?.instructions ?? null
    if (type === 'choice') {
      const criteria = q.criteria && Object.keys(q.criteria).length
        ? q.criteria
        : Object.fromEntries((q.options || []).map(o => [String(o), null]))
      if (Object.keys(criteria).length < 2) throw new Error(`question "${name}" needs at least two options`)
      out[name] = { type: 'choice', instructions, criteria }
    } else if (type === 'noul') {
      out[name] = { type: 'noul', instructions, ...(q.criteria ? { criteria: q.criteria } : {}) }
    } else if (type === 'score') {
      out[name] = { type: 'score', instructions, criteria: q.criteria || q.options }
    } else if (type === 'box') {
      out[name] = { type: 'box', instructions }
    } else {
      throw new Error(`question "${name}": unknown type "${q?.type}"`)
    }
  }
  return out
}

/**
 * Send a state object + typed questions. Returns:
 *   { ok: true,  answers: { qname: {...} }, raw }
 *   { ok: false, reason: 'disabled'|'paused'|'error', error }
 */
export async function askJev(state, questions, { timeoutMs = 15000 } = {}) {
  if (!isEnabled()) return { ok: false, reason: 'disabled' }
  if (Date.now() < _pausedUntil) return { ok: false, reason: 'paused', error: _pauseReason }
  try {
    const client = await getClient()
    const raw = await client.systemOne(
      { state: state ?? null, questions: toSdkQuestions(questions) },
      { timeout: timeoutMs },
    )
    return { ok: true, answers: raw?.answers || {}, raw }
  } catch (e) {
    if ([401, 402, 403].includes(e?.status)) {
      _pausedUntil = Date.now() + 10 * 60 * 1000
      _pauseReason = e.message
    }
    console.warn('[jev] ask failed:', e.status || '', String(e.message).slice(0, 120))
    return { ok: false, reason: 'error', error: e.message }
  }
}
