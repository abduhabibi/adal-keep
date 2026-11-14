/**
 * aiKeys.js — Google AI Studio keys the agency pastes in Settings (Photo
 * refining). Each is kept with the Google account it belongs to, locked like the
 * portal passwords (accountVault), and never sent back to a page: a page sees
 * the account, the last 4 characters and what Google said when it was checked.
 *
 * Picture editing is not part of Google's free plan: a key from an account
 * without billing answers 429 and is shown as "needs billing".
 */
import { seal, open } from './accountVault.js'

const KEY = 'ai_keys'
let cache = []            // [{ id, email, key, status, checked_at }]

export async function loadAiKeys(db) {
  try {
    const row = await db('settings').where({ key: KEY }).first()
    const raw = row?.value ? open(row.value) : '[]'
    cache = JSON.parse(raw || '[]')
    if (!Array.isArray(cache)) cache = []
  } catch { cache = [] }
  return cache
}

async function store(db) {
  const value = seal(JSON.stringify(cache))
  if (await db('settings').where({ key: KEY }).first()) await db('settings').where({ key: KEY }).update({ value })
  else await db('settings').insert({ key: KEY, value })
}

/** The keys to try for picture work: those that could refine first. */
export const refineKeys = () => [...cache].sort((a, b) => (b.status === 'ok') - (a.status === 'ok')).map(k => k.key)

/** What a page may see. */
export const publicKeys = () => cache.map(k => ({ id: k.id, email: k.email, ends: String(k.key).slice(-4), status: k.status || 'unchecked', checked_at: k.checked_at || null }))

export async function addAiKey(db, { email, key }) {
  const k = String(key || '').trim()
  if (!/^[A-Za-z0-9_\-]{30,60}$/.test(k)) throw Object.assign(new Error('That does not look like a Google AI Studio key (it starts with "AIza…")'), { status: 400 })
  if (cache.some(x => x.key === k)) throw Object.assign(new Error('That key is already saved'), { status: 400 })
  const row = { id: Date.now(), email: String(email || '').trim().slice(0, 120), key: k, status: 'unchecked', checked_at: null }
  cache.push(row)
  await store(db)
  return row.id
}

export async function removeAiKey(db, id) {
  cache = cache.filter(k => String(k.id) !== String(id))
  await store(db)
}

/** Asks Google with a tiny blank picture whether this key may edit pictures. */
export async function checkAiKey(db, id) {
  const k = cache.find(x => String(x.id) === String(id))
  if (!k) throw Object.assign(new Error('Key not found'), { status: 404 })
  const { canEditPictures } = await import('./photoRefine.js')
  k.status = await canEditPictures(k.key)
  k.checked_at = new Date().toISOString()
  await store(db)
  return k.status
}
