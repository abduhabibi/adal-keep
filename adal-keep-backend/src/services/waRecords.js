/**
 * The WhatsApp page's list: which girls went to which agents, when, by whom, from
 * which PC, and whether it arrived. Read from whatsapp_sends (copied between PCs);
 * newest first, a page at a time, or only what changed since the last look.
 */
import { changed } from './changes.js'

const PAGE = 50
const at = () => new Date().toISOString()
let hasCols = null
/** The columns of migration 069 (an update half done has not them yet: then nothing extra is written). */
export async function withWho(db) {
  if (hasCols === null) hasCols = await db.schema.hasColumn('whatsapp_sends', 'updated_at').catch(() => false) || null
  return !!hasCols
}

/** A row to write: the extra columns only where they are. */
export async function rowFor(db, row, extra = {}) {
  return (await withWho(db)) ? { ...row, ...extra, updated_at: at() } : row
}
export async function record(db, row, extra = {}) {
  const [id] = await db('whatsapp_sends').insert(await rowFor(db, row, extra))
  changed('whatsapp_sends')
  return id
}
export async function change(db, id, patch, extra = {}) {
  await db('whatsapp_sends').where('id', id).update(await rowFor(db, patch, extra))
  changed('whatsapp_sends')
}

/** WhatsApp said how far a message went (1 sent · 2 delivered · 3 read); never back. */
export async function acked(db, messageId, ack) {
  if (!db || !messageId || !(ack >= 1) || !(await withWho(db))) return 0
  const n = await db('whatsapp_sends').where('message_id', messageId).where(q => q.whereNull('ack').orWhere('ack', '<', ack))
    .update({ ack, acked_at: at(), updated_at: at() }).catch(() => 0)
  if (n) changed('whatsapp_sends')
  return n
}

const base = (db) => db('whatsapp_sends as s')
  .leftJoin('whatsapp_agents as a', 'a.id', 's.agent_id').leftJoin('profiles as p', 'p.id', 's.profile_id').leftJoin('cv_templates as t', 't.id', 's.template_id')
const COLUMNS = ['s.id', 's.profile_id', 's.agent_id', 's.template_id', 's.status', 's.error', 's.sent_at', 's.closed_at', 'a.name as agent_name', 'p.full_name as profile_name', 'p.passport_number', 't.name as template_name']
const WHO = ['s.sent_by', 's.sent_from', 's.ack', 's.acked_at', 's.updated_at']

/** { rows, more, upto }. agent: its id; girl: part of her name or passport, or her id; before: older than this id; since: only what changed after. */
export async function listSends(db, { agent = null, girl = '', before = null, since = '', status = '', limit = PAGE } = {}) {
  const who = await withWho(db)
  const n = Math.min(200, Math.max(1, Number(limit) || PAGE))
  let q = base(db).select(...COLUMNS, ...(who ? WHO : []))
  if (Number(agent)) q = q.where('s.agent_id', Number(agent))
  const g = String(girl || '').trim()
  if (/^\d{6,}$/.test(g)) q = q.where('s.profile_id', Number(g))
  else if (g) { const like = `%${g.replace(/[%_\\]/g, '\\$&')}%`; q = q.where(w => w.whereRaw("p.full_name LIKE ? ESCAPE '\\'", [like]).orWhereRaw("p.passport_number LIKE ? ESCAPE '\\'", [like])) }
  if (status === 'failed') q = q.where('s.status', 'failed')
  if (since && who) {
    const rows = await q.where('s.updated_at', '>', String(since)).orderBy('s.updated_at', 'asc').limit(200)
    return { rows, more: rows.length === 200, upto: rows.at(-1)?.updated_at || String(since) }
  }
  if (Number(before)) q = q.where('s.id', '<', Number(before))
  const rows = await q.orderBy('s.id', 'desc').limit(n + 1)
  const more = rows.length > n
  if (more) rows.pop()
  return { rows, more, upto: rows.map(r => r.updated_at || '').sort().at(-1) || at() }
}

/** The last time this girl's CV went to each of these agents: { agent_id: { at, by, times } } (a failed one does not count). */
export async function lastSent(db, profileId) {
  const rows = await db('whatsapp_sends').where('profile_id', Number(profileId)).whereNot('status', 'failed').whereNotNull('template_id').orderBy('id', 'asc')
    .select('agent_id', 'sent_at', 'status', ...(await withWho(db) ? ['sent_by'] : []))
  const out = {}
  for (const r of rows) out[r.agent_id] = { at: r.sent_at, by: r.sent_by || '', status: r.status, times: (out[r.agent_id]?.times || 0) + 1 }
  return out
}
