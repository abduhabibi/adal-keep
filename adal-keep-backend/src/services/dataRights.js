/**
 * A candidate's rights over her data (data protection): the consent line,
 * "give me everything about her" (a .zip: her record as JSON and her
 * documents) and "erase her" for good.
 *
 * Erase removes her rows, her documents and pictures (they do not go to the
 * Trash: the Trash entry is purged at once), her CVs and the robot history that
 * names her. The audit log keeps one line with her id and the word "erased" (no
 * name). Older backups (Telegram, the online storage) are locked copies that roll
 * over by themselves; they are not opened to cut her out.
 */
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import { storedPath } from './trash.js'

/** The profile's rows in every table that holds something about her. */
export async function gather(db, id) {
  const profile = await db('profiles').leftJoin('brokers', 'profiles.broker_id', 'brokers.id')
    .select('profiles.*', 'brokers.name as broker_name').where('profiles.id', id).first()
  if (!profile) return null
  const has = (t) => db.schema.hasTable(t).catch(() => false)
  const byProfile = async (t, col = 'profile_id') => ((await has(t)) && (await db.schema.hasColumn(t, col)) ? db(t).where(col, id) : [])
  const fields = await db('profile_fields').where('profile_id', id)
  const files = fields.length ? await db('files').whereIn('profile_field_id', fields.map(f => f.id)) : []
  return {
    profile, fields, files,
    generated_cvs: await byProfile('generated_cvs'),
    document_verifications: await byProfile('document_verifications'),
    checklist_profiles: await byProfile('checklist_profiles'),
    notes: await byProfile('notes'),
    tasks: await byProfile('tasks'),
    run_history: await byProfile('run_history'),
    audit_log: (await has('audit_log')) ? await db('audit_log').where({ target_kind: 'profile', target_id: id }).orderBy('id') : [],
  }
}

const storedFiles = (g) => [
  ...g.files.map(f => ({ name: `documents/${(g.fields.find(x => x.id === f.profile_field_id)?.name || 'document').replace(/[^\w.-]+/g, '_')}/${f.id}-${String(f.original_name || path.basename(f.path || 'file')).replace(/[^\w.-]+/g, '_')}`, p: f.path })),
  ...g.generated_cvs.map(c => ({ name: `cvs/${c.id}.pdf`, p: c.pdf_path })),
  ...['photo_path', 'full_body_photo_path', 'passport_file'].filter(k => g.profile[k]).map(k => ({ name: `photos/${k}${path.extname(g.profile[k])}`, p: g.profile[k] })),
]

// ---- a plain .zip (stored, no compression library needed) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0 }
export function makeZip(entries) {
  const parts = [], central = []; let offset = 0
  for (const { name, data } of entries) {
    const nm = Buffer.from(name, 'utf8'), comp = zlib.deflateRawSync(data), useDeflate = comp.length < data.length, body = useDeflate ? comp : data
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(useDeflate ? 8 : 0, 8)
    h.writeUInt32LE(crc32(data), 14); h.writeUInt32LE(body.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nm.length, 26)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(useDeflate ? 8 : 0, 10)
    c.writeUInt32LE(crc32(data), 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nm.length, 28); c.writeUInt32LE(offset, 42)
    parts.push(h, nm, body); central.push(c, nm); offset += 30 + nm.length + body.length
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cd, end])
}

/** Everything about one candidate as a .zip buffer (null: no such profile). */
export async function exportOne(db, id) {
  const g = await gather(db, id)
  if (!g) return null
  const entries = [], missing = []
  for (const f of storedFiles(g)) {
    const abs = f.p && storedPath(f.p)
    if (abs) entries.push({ name: f.name, data: fs.readFileSync(abs) }); else if (f.p) missing.push(f.name)
  }
  const doc = { exported_at: new Date().toISOString(), ...g, files_not_found: missing }
  entries.unshift({ name: 'candidate.json', data: Buffer.from(JSON.stringify(doc, null, 2)) })
  entries.unshift({ name: 'README.txt', data: Buffer.from('Everything Adal Keep holds about this candidate: candidate.json (her record, fields, notes, tasks, robot history and who looked at her data) and her documents, CVs and photos in the folders next to it.\n') })
  return { zip: makeZip(entries), name: g.profile.full_name }
}

/** The consent line: recorded with who and when; taken back with consent=false. */
export async function setConsent(db, id, consent, who) {
  const p = await db('profiles').where({ id }).first('id')
  if (!p) return null
  const on = consent === true || consent === 'true' || consent === 1 || consent === '1'
  await db('profiles').where({ id }).update({ data_consent: on, data_consent_at: on ? new Date().toISOString() : null, data_consent_by: on ? (who || null) : null })
  return { ok: true, data_consent: on }
}

const SCRUB = ['run_history', 'robot_lookups', 'crop_reviews', 'tasks', 'notes', 'automation_queue']
/** Erase one candidate for good. `confirmName` must be her full name. Returns what was removed. */
export async function eraseOne(db, id, confirmName, req = null) {
  const g = await gather(db, id)
  if (!g) return null
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ')
  if (norm(confirmName) !== norm(g.profile.full_name)) { const e = new Error('Type her full name exactly to erase her.'); e.status = 400; throw e }
  const { moveToTrash, purge } = await import('./trash.js')
  const entry = await moveToTrash(db, 'profile', id, req)
  if (entry) await purge(db, entry)
  const scrubbed = {}
  for (const t of SCRUB) {
    if (!(await db.schema.hasTable(t).catch(() => false)) || !(await db.schema.hasColumn(t, 'profile_id'))) continue
    scrubbed[t] = await db(t).where('profile_id', id).del().catch(() => 0)
  }
  if (await db.schema.hasTable('run_history_shots').catch(() => false)) {
    const ids = g.run_history.map(r => r.id)
    if (ids.length) await db('run_history_shots').whereIn('history_id', ids).del().catch(() => {})
  }
  // her earlier "viewed / exported" lines lose her name too
  await db('audit_log').where({ target_kind: 'profile', target_id: id }).update({ target_name: null }).catch(() => {})
  return { ok: true, removed: { profile: 1, fields: g.fields.length, files: g.files.length, cvs: g.generated_cvs.length, ...scrubbed } }
}
