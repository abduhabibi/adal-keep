/**
 * What a page downloaded is kept on this device (lib/idbStore.js): the next
 * visit shows it at once, and the fresh copy comes in behind it.
 *
 *   cachedGet('/brokers', { onSaved: (data) => show(data) })  → the fresh data
 *
 * (Every other GET is kept the same way by services/api.js; this one lets a
 * page show the saved copy and then the fresh one itself.)
 */
import api from '../services/api'
import { idbGet, idbPut, answerKey } from './idbStore'
import { changedGet, isList } from './changedOnly'

const keyOf = (url, params) => answerKey(api.defaults.baseURL, url, params)

const seen = new Map()
export const saved = (url, params) => idbGet(keyOf(url, params))
export const keep = (url, params, data) => idbPut(keyOf(url, params), data)

export async function cachedGet(url, { params, onSaved } = {}) {
  // A big list: whole once, then its changed rows; unchanged = the same object, not written again.
  const fresh = !params && isList(url)
    ? changedGet(url).then(d => { if (seen.get(url) !== d) { seen.set(url, d); keep(url, params, d) } return d })
    : api.get(url, { ...(params ? { params } : {}), adalNoCache: true }).then(r => { keep(url, params, r.data); return r.data })
  if (onSaved) {
    const old = await saved(url, params)
    if (old !== undefined) { try { onSaved(old) } catch {} }
  }
  return fresh
}
