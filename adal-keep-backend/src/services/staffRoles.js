/**
 * Staff roles (asked on 2026-11-22): the admin makes roles and gives each
 * employee one. A role is a set of simple toggles (PERMS). Three come ready:
 * Admin (everything), Office (everything but deleting, templates, settings
 * and staff) and Data entry (adding and editing profiles and uploading files
 * only — none of the toggles).
 *
 * Who is asking: the signed-in employee's key (X-Adal-Staff, given at
 * device-login, signed so it cannot name someone else), else the cookie of
 * the same sign-in. No employee signed in (this PC's own robots, a phone's
 * call replayed, Adal Admin, the owner) keeps everything, as before.
 * An employee with no role yet is an Admin: nothing changes until the admin
 * gives someone a smaller role.
 *
 * The guard below is checked on the server for every change, so a hidden
 * button is never the only thing in the way. The roles live in this PC's
 * database: Companions ask this PC, the online copy carries /staff-roles.
 */
import { signToken, verifyToken } from './tenancy.js'

export const PERMS = {
  delete_profiles: 'delete profiles',
  edit_templates: 'edit CV templates',
  run_robots: 'run robots',
  change_settings: 'change settings',
  manage_staff: 'manage staff',
  export_backup: 'export and back up',
}
const ALL = Object.fromEntries(Object.keys(PERMS).map(k => [k, true]))
const NONE = Object.fromEntries(Object.keys(PERMS).map(k => [k, false]))
export const PRESETS = [
  { preset: 'admin', name: 'Admin', perms: ALL },
  { preset: 'office', name: 'Office', perms: { ...NONE, run_robots: true, export_backup: true } },
  { preset: 'data_entry', name: 'Data entry', perms: NONE },
]

/** Only the known toggles, each true or false. */
export function cleanPerms(p) {
  const src = typeof p === 'string' ? (() => { try { return JSON.parse(p) } catch { return {} } })() : (p || {})
  return Object.fromEntries(Object.keys(PERMS).map(k => [k, src[k] === true]))
}

// Made once per database (the tables are made at start by tenancy, after the migrations).
const ready = new WeakMap()
export function ensureStaffRoles(db) {
  if (!ready.has(db)) {
    ready.set(db, (async () => {
      if (!(await db.schema.hasTable('staff_roles'))) {
        await db.schema.createTable('staff_roles', t => {
          t.increments('id').primary(); t.string('name', 60).notNullable(); t.string('preset', 20).nullable()
          t.text('perms'); t.timestamps(true, true)
        })
      }
      for (const p of PRESETS) {
        if (!(await db('staff_roles').where({ preset: p.preset }).first())) {
          await db('staff_roles').insert({ name: p.name, preset: p.preset, perms: JSON.stringify(p.perms) })
        }
      }
      if ((await db.schema.hasTable('users')) && !(await db.schema.hasColumn('users', 'role_id'))) {
        await db.schema.table('users', t => t.integer('role_id').nullable())
      }
      if ((await db.schema.hasTable('users')) && !(await db.schema.hasColumn('users', 'pin_set'))) {
        await db.schema.table('users', t => t.boolean('pin_set').nullable())
      }
      // No users table yet (a new install before its setup): looked at again next time.
      if (!(await db.schema.hasTable('users'))) ready.delete(db)
    })().catch((e) => { ready.delete(db); throw e }))
  }
  return ready.get(db)
}

export async function listRoles(db) {
  await ensureStaffRoles(db)
  const rows = await db('staff_roles').select('*').orderBy('id')
  const users = await db('users').select('role_id').catch(() => [])
  const admin = rows.find(r => r.preset === 'admin')
  const count = (r) => users.filter(u => (u.role_id ?? admin?.id) === r.id).length
  return rows.map(r => ({ id: r.id, name: r.name, preset: r.preset || null, perms: r.preset === 'admin' ? { ...ALL } : cleanPerms(r.perms), members: count(r) }))
}

/** The role of one employee (no role, or a role gone: Admin). */
export async function roleOf(db, user) {
  const roles = await listRoles(db)
  return roles.find(r => r.id === user?.role_id) || roles.find(r => r.preset === 'admin')
}

export const staffToken = (user) => signToken({ staff: user.id })

/** The employee asking: { user } for one signed in, null for no one. */
export async function whoIsAsking(db, req) {
  let id = null
  const head = req.get?.('x-adal-staff') || req.headers?.['x-adal-staff']
  if (head) {
    const d = verifyToken(String(head))
    if (d?.staff) id = Number(d.staff)
    // A key that is not ours: nobody (but not the owner either).
    else return { user: null, unknown: true }
  } else if (req.auth?.uid) id = Number(req.auth.uid)
  if (!id) return null
  const user = await db('users').where({ id }).first().catch(() => null)
  // Signed in as an employee who was deleted since: nothing allowed.
  return user ? { user } : { user: null, unknown: true }
}

/** What the asker may do: { perms, role, user } (everything for no one signed in). */
export async function permsFor(db, req) {
  await ensureStaffRoles(db)
  const who = await whoIsAsking(db, req)
  if (!who) return { perms: { ...ALL }, role: null, user: null }
  if (!who.user) return { perms: { ...NONE }, role: null, user: null }
  const role = await roleOf(db, who.user)
  return { perms: role.perms, role, user: who.user }
}

// Which toggle each change needs (method, path under /api). The first match wins.
const W = '(POST|PUT|PATCH|DELETE)'
const RULES = [
  // Signing in, out and back in on a device is never stopped.
  [/^(GET|POST|PUT|PATCH|DELETE) \/employees\/device-(login|resume|logout)$/, null],
  [/^DELETE \/profiles\/\d+$/, 'delete_profiles'],
  [/^POST \/trash\/(\d+\/purge|empty)$/, 'delete_profiles'],
  [/^POST \/cv\/templates\/preview-html$/, null],
  [new RegExp(`^${W} \\/cv\\/(templates|headers)(\\/|$)`), 'edit_templates'],
  [/^POST \/profiles\/\d+\/automations\/[^/]+\/start$/, 'run_robots'],
  [/^POST \/automations\/\d+\/(resume|pause|cancel|complete)$/, 'run_robots'],
  [/^POST \/transitions\/[^/]+\/(start|stop)$/, 'run_robots'],
  [/^POST \/contracts\/(check|scan|cancel)$/, 'run_robots'],
  [/^POST \/wafid\/(book\/\d+|check)$/, 'run_robots'],
  [/^POST \/sessions\/[^/]+\/open$/, 'run_robots'],
  [/^POST \/backup\/settings$/, 'change_settings'],
  [/^POST \/backup\/(run|restore|restore-companion|test|find-chats)$/, 'export_backup'],
  [/^GET \/branch\/export(\/|$)/, 'export_backup'],
  [new RegExp(`^${W} \\/settings(\\/|$)`), 'change_settings'],
  [new RegExp(`^${W} \\/system\\/ai-keys(\\/|$)`), 'change_settings'],
  [new RegExp(`^${W} \\/(lmis|musaned|visa|tasheer|insurance)\\/accounts(\\/|$)`), 'change_settings'],
  [new RegExp(`^${W} \\/whatsapp\\/(agents|connect|logout|notify)(\\/|$)`), 'change_settings'],
  [/^POST \/wafid\/settings$/, 'change_settings'],
  [/^POST \/main-pc(\/|$)/, 'change_settings'],
  [new RegExp(`^${W} \\/(employees|staff-roles)(\\/|$)`), 'manage_staff'],
]

/** The toggle a request needs, or null. */
export function permNeeded(method, path) {
  const key = `${String(method).toUpperCase()} ${String(path).split('?')[0].replace(/\/+$/, '') || '/'}`
  for (const [re, perm] of RULES) if (re.test(key)) return perm
  return null
}

/** Express guard for /api: refuses what the asker's role does not allow (403). */
export function staffGuard(req, res, next) {
  const perm = permNeeded(req.method, req.path)
  if (!perm) return next()
  const db = req.app.locals.db
  permsFor(db, req).then(({ perms, role }) => {
    if (perms[perm]) return next()
    res.status(403).json({
      error: `Your role${role ? ` (${role.name})` : ''} cannot ${PERMS[perm]}. Ask the admin.`,
      forbidden: perm,
    })
  }).catch((e) => res.status(500).json({ error: 'Could not check your role: ' + e.message }))
}

/** Some employee has a role that cannot manage staff: the admins' sign-in asks for their PIN. */
export async function rolesInUse(db) {
  const roles = await listRoles(db)
  return roles.some(r => r.members > 0 && !r.perms.manage_staff)
}
