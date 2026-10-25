/**
 * trash.js — nothing anyone deletes is gone at once.
 *
 * Before a delete, the item and everything that belongs to it (a profile's
 * fields, documents, checks, CVs, checklist places…) is saved as one trash
 * entry, and its files are moved into data/Trash/<entry>/. Only the main PC
 * itself sees the Trash (routes/trash.js) and can restore an entry exactly
 * as it was, or delete it for good.
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const BACKEND = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SAFE = path.join(BACKEND, 'data', 'SafeStorage')
export const TRASH_DIR = path.join(BACKEND, 'data', 'Trash')

/** Where a stored file really is (stored paths come in a few forms). */
export function storedPath(p) {
  if (!p) return null
  for (const c of [path.isAbsolute(p) ? p : null, path.join(BACKEND, p), path.join(SAFE, path.basename(p)), path.join(process.cwd(), p)]) {
    if (c && fs.existsSync(c)) return c
  }
  return null
}
const thumbOf = (abs) => abs && abs.replace(/(\.\w+)$/, '_thumb$1')

const rows = (db, table, col, ids) => (ids.length ? db(table).whereIn(col, ids) : Promise.resolve([]))

/** What one item takes with it: { title, tables: { table: rows }, files: [abs paths] }. */
const KINDS = {
  async profile(db, id) {
    const p = await db('profiles').where('id', id).first()
    if (!p) return null
    const fields = await db('profile_fields').where('profile_id', id)
    const files = await rows(db, 'files', 'profile_field_id', fields.map(f => f.id))
    const cvs = await db('generated_cvs').where('profile_id', id).catch(() => [])
    const paths = [...files.map(f => f.path), ...cvs.map(c => c.pdf_path), p.photo_path, p.full_body_photo_path, p.passport_file]
    return {
      title: p.full_name || `Profile #${id}`,
      tables: {
        profiles: [p], profile_fields: fields, files, generated_cvs: cvs,
        document_verifications: await db('document_verifications').where('profile_id', id).catch(() => []),
        checklist_profiles: await db('checklist_profiles').where('profile_id', id).catch(() => []),
      },
      paths,
    }
  },
  async file(db, id) {
    const f = await db('files').where('id', id).first()
    if (!f) return null
    const field = await db('profile_fields').where('id', f.profile_field_id).first().catch(() => null)
    const prof = field ? await db('profiles').where('id', field.profile_id).first().catch(() => null) : null
    return { title: `${f.original_name || 'Document'}${prof ? ` — ${prof.full_name}` : ''}${field ? ` (${field.name})` : ''}`, tables: { files: [f] }, paths: [f.path] }
  },
  async broker(db, id) {
    const b = await db('brokers').where('id', id).first()
    if (!b) return null
    const linked = await db('profiles').where('broker_id', id).select('id')
    return { title: b.name, tables: { brokers: [b] }, paths: [], extra: { profiles: linked.map(r => r.id) } }
  },
  async employee(db, id) {
    const u = await db('users').where('id', id).first()
    return u && { title: u.name || u.username, tables: { users: [u] }, paths: [] }
  },
  async cv_template(db, id) {
    const t = await db('cv_templates').where('id', id).first()
    return t && { title: t.name, tables: { cv_templates: [t] }, paths: [t.header_path, t.footer_path, t.logo_path] }
  },
  async generated_cv(db, id) {
    const c = await db('generated_cvs').where('id', id).first()
    if (!c) return null
    const files = await db('files').where('path', c.pdf_path)
    const prof = await db('profiles').where('id', c.profile_id).first().catch(() => null)
    return { title: `CV ${c.filename || ''}${prof ? ` — ${prof.full_name}` : ''}`, tables: { generated_cvs: [c], files }, paths: [c.pdf_path] }
  },
  async checklist(db, id) {
    const c = await db('checklists').where('id', id).first()
    return c && { title: c.name, tables: { checklists: [c], checklist_profiles: await db('checklist_profiles').where('checklist_id', id) }, paths: [] }
  },
  async task(db, id) {
    const t = await db('tasks').where('id', id).first()
    return t && { title: t.title || `Task #${id}`, tables: { tasks: [t] }, paths: [] }
  },
  async quick_link(db, id) {
    const q = await db('quick_links').where('id', id).first()
    return q && { title: q.name, tables: { quick_links: [q] }, paths: [] }
  },
  async lmis_account(db, id) {
    const a = await db('lmis_accounts').where('id', id).first()
    return a && { title: `LMIS account ${a.name}`, tables: { lmis_accounts: [a] }, paths: [] }
  },
  async musaned_account(db, id) {
    const a = await db('musaned_accounts').where('id', id).first()
    return a && { title: `Musaned account ${a.name}`, tables: { musaned_accounts: [a] }, paths: [] }
  },
  async tasheer_account(db, id) {
    const a = await db('tasheer_accounts').where('id', id).first()
    return a && { title: `Tasheer account ${a.name}`, tables: { tasheer_accounts: [a] }, paths: [] }
  },
  async insurance_account(db, id) {
    const a = await db('insurance_accounts').where('id', id).first()
    return a && { title: `Insurance account ${a.name}`, tables: { insurance_accounts: [a] }, paths: [] }
  },
  async visa_account(db, id) {
    const a = await db('visa_accounts').where('id', id).first()
    return a && { title: `Visa platform account ${a.name}`, tables: { visa_accounts: [a] }, paths: [] }
  },
}

// Restore parents before children; delete children before parents.
const ORDER = ['brokers', 'users', 'cv_templates', 'checklists', 'profiles', 'profile_fields', 'files', 'generated_cvs',
  'document_verifications', 'checklist_profiles', 'tasks', 'quick_links', 'lmis_accounts', 'musaned_accounts', 'visa_accounts', 'tasheer_accounts', 'insurance_accounts']

/** Who deleted it: the employee name the page sends, and from which PC. */
export function whoFrom(req) {
  let name = String(req.get?.('x-adal-who') || '')
  try { name = decodeURIComponent(name) } catch {}
  name = name.slice(0, 80)
  const fwd = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim()
  let ip = (fwd || String(req.socket?.remoteAddress || '')).replace(/^::ffff:/, '')
  if (ip === '::1' || ip === '127.0.0.1') ip = 'this PC'
  return { deleted_by: name || null, deleted_from: ip || null }
}

/**
 * Put an item in the trash and delete it. Returns the trash entry id, or
 * null when the item does not exist (nothing deleted).
 */
export async function moveToTrash(db, kind, id, req = null) {
  const collect = KINDS[kind]
  if (!collect) throw new Error(`unknown trash kind ${kind}`)
  const item = await collect(db, Number(id))
  if (!item) return null

  const now = new Date().toISOString()
  const [trashId] = await db('trash').insert({
    kind, item_id: Number(id), title: String(item.title || kind).slice(0, 200),
    payload: JSON.stringify({ tables: item.tables, extra: item.extra || null }), files: '[]',
    ...(req ? whoFrom(req) : {}), deleted_at: now,
  })

  // Files: moved (not copied) into the entry's folder; remember where they were.
  const dir = path.join(TRASH_DIR, String(trashId))
  const moved = []
  const seen = new Set()
  for (const p of item.paths || []) {
    for (const abs of [storedPath(p), thumbOf(storedPath(p))]) {
      if (!abs || seen.has(abs) || !fs.existsSync(abs)) continue
      seen.add(abs)
      fs.mkdirSync(dir, { recursive: true })
      const to = path.join(dir, `${moved.length}-${path.basename(abs)}`)
      try { fs.renameSync(abs, to) } catch { fs.copyFileSync(abs, to); fs.unlinkSync(abs) }
      moved.push({ from: abs, to })
    }
  }
  await db('trash').where('id', trashId).update({ files: JSON.stringify(moved) })

  // Delete the rows, children first.
  for (const table of [...ORDER].reverse()) {
    const list = item.tables[table]
    if (!list?.length) continue
    await db(table).whereIn('id', list.map(r => r.id).filter(v => v !== undefined)).del().catch(async () => {
      // tables without an id column (checklist_profiles)
      for (const r of list) await db(table).where(r).del().catch(() => {})
    })
  }
  if (kind === 'broker') await db('profiles').where('broker_id', Number(id)).update({ broker_id: null }).catch(() => {})
  return trashId
}

/** Put a trash entry back exactly as it was. */
export async function restore(db, trashId) {
  const t = await db('trash').where('id', trashId).first()
  if (!t) throw new Error('not in the trash')
  const { tables, extra } = JSON.parse(t.payload || '{}')
  for (const table of ORDER) {
    for (const row of tables?.[table] || []) {
      const exists = row.id !== undefined ? await db(table).where('id', row.id).first().catch(() => null) : null
      if (!exists) await db(table).insert(row).catch(e => console.warn(`[trash] restore ${table}:`, e.message))
    }
  }
  if (t.kind === 'broker' && extra?.profiles?.length) {
    await db('profiles').whereIn('id', extra.profiles).whereNull('broker_id').update({ broker_id: t.item_id }).catch(() => {})
  }
  for (const f of JSON.parse(t.files || '[]')) {
    if (!fs.existsSync(f.to)) continue
    fs.mkdirSync(path.dirname(f.from), { recursive: true })
    try { fs.renameSync(f.to, f.from) } catch { fs.copyFileSync(f.to, f.from); fs.unlinkSync(f.to) }
  }
  fs.rmSync(path.join(TRASH_DIR, String(trashId)), { recursive: true, force: true })
  await db('trash').where('id', trashId).del()
  return { ok: true, kind: t.kind, id: t.item_id }
}

/** Delete a trash entry for good (its files too). */
export async function purge(db, trashId) {
  fs.rmSync(path.join(TRASH_DIR, String(trashId)), { recursive: true, force: true })
  await db('trash').where('id', trashId).del()
  return { ok: true }
}
