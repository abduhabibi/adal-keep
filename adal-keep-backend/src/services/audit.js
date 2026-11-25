/**
 * The audit log: who viewed, downloaded, exported or erased which candidate's
 * data, when and from which PC (table audit_log, migration 066). It lives in the
 * main PC's database like everything else, so every PC reads the same log.
 *
 * Writing a line never breaks the request: it is done after the answer's work,
 * errors are only warned, and the same person looking at the same thing within
 * 10 minutes is one line (an open page refreshes itself).
 */
import { whoFrom } from './trash.js'

const AGAIN_MS = 10 * 60 * 1000
const recentBy = new WeakMap()   // per database

function actor(req) {
  const { deleted_by, deleted_from } = whoFrom(req)
  const phone = req.get?.('x-adal-phone') || /AdalKeepPhone/.test(String(req.get?.('user-agent') || ''))
  return { who: deleted_by || (phone ? 'phone' : 'this PC'), from_pc: phone ? 'phone' : deleted_from }
}

let ready = new WeakMap()
async function ensure(db) {
  if (ready.has(db)) return ready.get(db)
  const p = (async () => {
    if (await db.schema.hasTable('audit_log')) return true
    await (await import('../migrations/066_data_protection.js')).up(db)
    return true
  })().catch(() => false)
  ready.set(db, p)
  return p
}

/** Add one line. Resolves to the row id, or null (never throws). */
export async function record(db, req, { action, kind = 'profile', id = null, name = null, detail = null }) {
  try {
    if (!(await ensure(db))) return null
    const a = actor(req)
    const recent = recentBy.get(db) || recentBy.set(db, new Map()).get(db)
    const key = `${a.who}|${action}|${kind}|${id}`
    const now = Date.now()
    if (action === 'viewed' || action === 'downloaded') {
      if (now - (recent.get(key) || 0) < AGAIN_MS) return null
      recent.set(key, now)
      if (recent.size > 5000) for (const [k, t] of recent) if (now - t > AGAIN_MS) recent.delete(k)
    }
    if (name == null && id != null && kind === 'profile') name = (await db('profiles').where({ id }).first('full_name').catch(() => null))?.full_name || null
    const [row] = await db('audit_log').insert({
      at: new Date(now).toISOString(), who: a.who, from_pc: a.from_pc, action, target_kind: kind,
      target_id: id, target_name: name ? String(name).slice(0, 120) : null, detail: detail ? String(detail).slice(0, 500) : null,
    })
    return row
  } catch (e) { console.warn('[audit]', e.message); return null }
}

export async function list(db, { profile_id, action, limit = 200 } = {}) {
  if (!(await ensure(db))) return []
  const q = db('audit_log').orderBy('id', 'desc').limit(Math.min(1000, Math.max(1, Number(limit) || 200)))
  if (profile_id) q.where({ target_kind: 'profile', target_id: Number(profile_id) })
  if (action) q.where({ action })
  return q
}

/** Express middleware: opening a profile and downloading a document are lines in the log. */
export function auditViews(req, res, next) {
  // (The online copy's own reading is not a person looking: it wrote a "viewed" line for every profile each sweep.)
  const ownRead = req.get?.('x-adal-cloud') && !req.get?.('x-adal-who')
  if (req.method === 'GET' && !ownRead) {
    const p = req.path
    let m
    if ((m = /^\/profiles\/(\d+)$/.exec(p))) res.on('finish', () => { if (res.statusCode < 300) record(req.app.locals.db, req, { action: 'viewed', id: Number(m[1]) }) })
    else if ((m = /^\/files\/(\d+)\/download$/.exec(p))) {
      res.on('finish', () => { if (res.statusCode < 300) fileLine(req, Number(m[1])) })
    }
  }
  next()
}
async function fileLine(req, fileId) {
  const db = req.app.locals.db
  try {
    const f = await db('files').where('id', fileId).first()
    const field = f && await db('profile_fields').where('id', f.profile_field_id).first().catch(() => null)
    await record(db, req, { action: 'downloaded', kind: 'file', id: fileId, name: f?.original_name || null, detail: field ? `profile ${field.profile_id}, ${field.name}` : null })
  } catch {}
}
