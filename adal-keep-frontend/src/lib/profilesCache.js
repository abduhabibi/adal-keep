/**
 * The profiles list, asked for once and shared by the pages that need all of
 * it (Profiles, Brokers, Checklist): going from one to the other does not
 * download thousands of profiles again. Kept 30 s; anything saved from this
 * device (any change sent to the PC) makes the next ask a fresh one.
 */
import api from '../services/api'

const KEEP_MS = 30_000
let hit = null // { at, promise }

api.interceptors.response.use((r) => {
  if (r?.config?.method && r.config.method.toLowerCase() !== 'get') hit = null
  return r
})

export function profilesList({ fresh = false } = {}) {
  if (!fresh && hit && Date.now() - hit.at < KEEP_MS) return hit.promise
  const promise = api.get('/profiles').then(r => r.data || [])
  hit = { at: Date.now(), promise }
  promise.catch(() => { if (hit?.promise === promise) hit = null })
  return promise
}

export const forgetProfiles = () => { hit = null }
