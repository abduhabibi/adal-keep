/**
 * TypeSafe (JEV) keys: TYPESAFE_API_KEY first (env or the secret store), then
 * the backups in TYPESAFE_API_KEYS (comma-separated). A key that is out of
 * credits (402) or refused (401/403) rests and the next key answers instead;
 * only when every key fails does the caller see the error.
 */
import { getSecret } from '../secretStore.js'

const REST_MS = 10 * 60 * 1000
const resting = new Map() // key → time it may be used again
const clients = new Map() // `${tag}:${key}` → client
let at = 0

export function jevKeys() {
  return [...new Set([getSecret('TYPESAFE_API_KEY'), process.env.TYPESAFE_API_KEY,
    ...String(process.env.TYPESAFE_API_KEYS || '').split(/[,;\s]+/)]
    .map(k => String(k || '').trim()).filter(Boolean))]
}

const keyProblem = (e) => [401, 402, 403].includes(e?.status)

/**
 * Run `fn(client)` with a working key. `make(sdk, key)` builds a client for a
 * key (built once per tag + key).
 */
export async function withJevKey(tag, make, fn) {
  const keys = jevKeys()
  if (!keys.length) throw Object.assign(new Error('no TypeSafe key'), { status: 401 })
  const sdk = await import('@typesafe-ai/sdk')
  const order = keys.map((_, i) => keys[(at + i) % keys.length])
  const usable = order.filter(k => (resting.get(k) || 0) <= Date.now())
  let lastErr = null
  for (const key of usable.length ? usable : order.slice(0, 1)) {
    const id = `${tag}:${key}`
    if (!clients.has(id)) clients.set(id, make(sdk, key))
    try {
      const out = await fn(clients.get(id), sdk)
      at = keys.indexOf(key)
      return out
    } catch (e) {
      if (!keyProblem(e) || keys.length === 1) throw e
      lastErr = e
      resting.set(key, Date.now() + REST_MS)
      console.warn(`[jev] key ${keys.indexOf(key) + 1} of ${keys.length} ${e.status === 402 ? 'has no credits' : 'was refused'} — trying the next key`)
    }
  }
  throw lastErr
}
