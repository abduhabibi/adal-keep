/**
 * The profiles list, asked for once and shared by the pages that need all of
 * it (Profiles, Brokers, Checklist): going from one to the other does not
 * download thousands of profiles again. Kept 30 s in memory and on the device
 * (deviceCache) — a visit shows the saved list at once (onSaved), the fresh
 * one comes in behind it. Anything saved from this device makes the next ask
 * a fresh one.
 */
import api from '../services/api'
import { cachedGet } from './deviceCache'

const KEEP_MS = 30_000
let hit = null // { at, promise }

api.interceptors.response.use((r) => {
  if (r?.config?.method && r.config.method.toLowerCase() !== 'get') hit = null
  return r
})

export function profilesList({ fresh = false, onSaved } = {}) {
  if (!fresh && hit && Date.now() - hit.at < KEEP_MS) {
    // Still on its way (a slow line): the copy kept on this device shows meanwhile.
    if (onSaved) import('./deviceCache').then(d => d.saved('/profiles')).then(old => { if (old !== undefined) onSaved(old) }).catch(() => {})
    return hit.promise
  }
  const promise = cachedGet('/profiles', { onSaved }).then(d => d || [])
  hit = { at: Date.now(), promise }
  promise.catch(() => { if (hit?.promise === promise) hit = null })
  return promise
}

export const forgetProfiles = () => { hit = null }
