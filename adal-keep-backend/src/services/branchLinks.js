/**
 * Branches: two agencies linked with a 6-digit code — no second password.
 * (Supabase: adal-admin/supabase/branch-links.sql; docs/branch-links.md.)
 *
 *   Settings → Branches: search an agency by name (name and city only) →
 *   Connect → that agency gets "<Agency> wants to link as your branch" →
 *   "Yes, it is me" shows them a 6-digit code (10 minutes, once) → they tell
 *   it to the sender, who types it → linked both ways.
 *
 * Linked: each one sees the other's profile summaries (name, passport
 * number, stage, status) from its online copy, refreshed every 5 minutes, as
 * long as the other shares them. Never documents, never passwords.
 * Only the main PC links (it holds the agency's account); other PCs ask it.
 */
import { cloudCall, cloudAgencyId, me } from './chatCloud.js'

const rpc = (db, name, args = {}) => cloudCall(db, 'POST', `/rest/v1/rpc/${name}`, args)

export class BranchError extends Error {
  constructor(message, status = 400) { super(message); this.status = status }
}

// A missing function means the SQL was not run yet: say which file.
const plain = (e) => {
  const m = String(e?.message || e)
  if (/keep_branch|keep_set_city|PGRST202|schema cache|Could not find the function/i.test(m)) return new BranchError('Branches are not on the online server yet: Adal runs adal-admin/supabase/branch-links.sql in Supabase once.', 503)
  return new BranchError(m.replace(/^.*?exception:\s*/i, ''), e?.status && e.status < 500 ? e.status : 400)
}
const call = async (db, name, args) => { try { return await rpc(db, name, args) } catch (e) { throw plain(e) } }

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const id = (v) => { if (!ID.test(String(v || ''))) throw new BranchError('Not a known agency or request.'); return String(v) }

// What the sender sees for each answer of keep_branch_verify.
export const VERIFY = {
  wrong: 'That code is not right. Check it with the other agency and type it again.',
  expired: 'That code is older than 10 minutes. Ask them to press "Yes, it is me" again for a new code.',
  used: 'That code was already used.',
  too_many: 'Too many wrong codes. Press Connect again.',
  not_yet: 'They have not pressed "Yes, it is me" yet. Ask them to open Settings → Branches.',
  gone: 'That request is gone. Press Connect again.',
}

async function ready(db) { await me(db) }   // signed in, and this agency's name is on the server

export async function search(db, q) {
  const text = String(q || '').trim().slice(0, 60)
  if (text.length < 2) return []
  await ready(db)
  const rows = await call(db, 'keep_branch_search', { p_q: text })
  return (rows || []).map(r => ({ id: r.id, name: r.name, city: r.city || null, linked: !!r.linked }))
}

export async function ask(db, agencyId) {
  await ready(db)
  return { id: await call(db, 'keep_branch_ask', { p_to: id(agencyId) }) }
}

/** "Yes, it is me": the code to tell the other agency. */
export async function yes(db, requestId) {
  await ready(db)
  const code = await call(db, 'keep_branch_confirm', { p_id: id(requestId) })
  return { code: String(code), until: new Date(Date.now() + 10 * 60000).toISOString() }
}

export async function no(db, requestId) {
  await ready(db)
  await call(db, 'keep_branch_deny', { p_id: id(requestId) })
  return { ok: true }
}

export async function verify(db, requestId, code) {
  const digits = String(code || '').replace(/\D/g, '')
  if (digits.length !== 6) throw new BranchError('Type the 6 digits.')
  await ready(db)
  const answer = String(await call(db, 'keep_branch_verify', { p_id: id(requestId), p_code: digits }))
  if (answer !== 'linked') throw new BranchError(VERIFY[answer] || answer, 400)
  kept.clear()
  refreshSoon(db)
  return { linked: true }
}

export async function unlink(db, agencyId) {
  await ready(db)
  await call(db, 'keep_branch_unlink', { p_other: id(agencyId) })
  kept.delete(String(agencyId))
  return { ok: true }
}

export async function share(db, agencyId, on) {
  await ready(db)
  await call(db, 'keep_branch_share', { p_other: id(agencyId), p_on: !!on })
  return { ok: true }
}

export async function setCity(db, city) {
  const value = String(city || '').trim().slice(0, 60)
  await ready(db)
  await call(db, 'keep_set_city', { p_city: value })
  const at = new Date().toISOString()
  const row = await db('settings').where({ key: 'agency_city' }).first().catch(() => null)
  if (row) await db('settings').where({ key: 'agency_city' }).update({ value, updated_at: at })
  else await db('settings').insert({ key: 'agency_city', value, created_at: at, updated_at: at })
  return { city: value }
}

/** Settings → Branches in one call: the links, asked of us, what we asked. */
export async function state(db) {
  await ready(db)
  const [links, inbox, outbox, city] = await Promise.all([
    call(db, 'keep_branch_list'),
    call(db, 'keep_branch_inbox'),
    call(db, 'keep_branch_outbox'),
    db('settings').where({ key: 'agency_city' }).first().then(r => r?.value || '').catch(() => ''),
  ])
  return {
    city,
    links: (links || []).map(l => ({
      id: l.agency_id, name: l.name, city: l.city || null, since: l.since,
      iShare: !!l.i_share, theyShare: !!l.they_share, lastSeen: l.last_seen,
      profiles: kept.get(String(l.agency_id))?.rows.size ?? null,
      updated: kept.get(String(l.agency_id))?.at || null,
    })),
    inbox: (inbox || []).map(r => ({ id: r.id, agencyId: r.agency_id, name: r.name, city: r.city || null, status: r.status, at: r.created_at })),
    outbox: (outbox || []).map(r => ({ id: r.id, agencyId: r.agency_id, name: r.name, city: r.city || null, status: r.status, at: r.created_at, tries: r.tries })),
  }
}

// ---------------------------------------------------------- shared profiles
// Per linked agency: id → summary, and the newest updated_at seen (the next
// pull asks only what changed since).
const kept = new Map()   // agency id → { rows: Map, since, at }

export async function pullProfiles(db, agencyId) {
  const key = id(agencyId)
  const k = kept.get(key) || { rows: new Map(), since: null, at: null }
  const rows = await call(db, 'keep_branch_profiles', { p_other: key, p_since: k.since })
  for (const r of rows || []) {
    if (r.deleted) k.rows.delete(String(r.id))
    else k.rows.set(String(r.id), { id: r.id, name: r.name, passport: r.passport, stage: r.stage, status: r.status, nationality: r.nationality, updated_at: r.updated_at })
    if (!k.since || r.updated_at > k.since) k.since = r.updated_at
  }
  k.at = new Date().toISOString()
  kept.set(key, k)
  return k
}

export async function profiles(db, agencyId, { fresh = false } = {}) {
  const key = id(agencyId)
  await ready(db)
  let k = kept.get(key)
  if (!k || fresh || Date.now() - new Date(k.at) > 60000) k = await pullProfiles(db, key)
  return { updated: k.at, profiles: [...k.rows.values()].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))) }
}

// ---------------------------------------------------------- the watcher
// Every 30 s: a new "wants to link" → a notification and a beep.
// Every 5 min: the linked branches' profile summaries.
const told = new Set()
let refreshTimer = null
function refreshSoon(db) { clearTimeout(refreshTimer); refreshTimer = setTimeout(() => refreshAll(db).catch(() => {}), 2000) }

export async function refreshAll(db) {
  const links = await call(db, 'keep_branch_list')
  const ids = new Set((links || []).map(l => String(l.agency_id)))
  for (const k of [...kept.keys()]) if (!ids.has(k)) kept.delete(k)
  for (const l of links || []) {
    if (!l.they_share) { kept.delete(String(l.agency_id)); continue }
    await pullProfiles(db, l.agency_id).catch(e => console.warn(`[branches] ${l.name}: ${e.message}`))
  }
  import('./changes.js').then(c => c.changed('branches')).catch(() => {})
}

export async function watchInbox(db) {
  const inbox = await call(db, 'keep_branch_inbox')
  for (const r of inbox || []) {
    if (told.has(r.id)) continue
    told.add(r.id)
    if (r.status !== 'pending') continue
    const now = new Date().toISOString()
    await db('notifications').insert({
      type: 'branch_link',
      title: `🔗 ${r.name} wants to link as your branch`,
      body: `${r.city ? `${r.name} (${r.city})` : r.name} pressed Connect. If it is really your branch, open Settings → Branches and press "Yes, it is me", then tell them the 6-digit code.`,
      created_day: now.slice(0, 10), created_at: now, updated_at: now,
    }).catch(e => console.warn('[branches] notification:', e.message))
    try { (await import('./worker.js')).beep() } catch {}
    console.log(`[branches] "${r.name}" wants to link as a branch`)
  }
  if (inbox?.length) import('./changes.js').then(c => c.changed('branches')).catch(() => {})
}

let started = false
export function startBranchLinks(db, { isMain = () => true, configured = () => true } = {}) {
  if (started) return
  started = true
  let n = 0
  const tick = async () => {
    if (!isMain() || !configured()) return
    try {
      if (!(await cloudAgencyId(db))) return
      await ready(db)
      await watchInbox(db)
      if (n++ % 10 === 0) await refreshAll(db)
    } catch (e) {
      if (!/not on the online server/.test(e.message)) console.warn('[branches]', e.message)
    }
  }
  setTimeout(tick, 60000).unref?.()
  setInterval(tick, 30000).unref?.()
}
