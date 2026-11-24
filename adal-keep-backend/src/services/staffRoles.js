/**
 * Staff roles (asked on 2026-11-22): the admin makes roles and gives each
 * employee one. A role is a set of simple toggles (PERMS). Three come ready:
 * Admin (everything), Office (everything but deleting, templates, settings
 * and staff) and Data entry (adding and editing profiles and uploading files
 * only — none of the toggles).
 *
 * Who is asking (whoIsAsking): the signed-in employee's key (X-Adal-Staff,
 * given at device-login, signed so it cannot name someone else), else the
 * cookie of the same sign-in. This PC's own window and the phones with no one signed
 * in work as the PC's default employee (pcDefaultStaff, asked on 2026-11-23); another
 * computer's window with no one signed in may only look, unless no employee can manage staff yet (a new agency). Phones, and calls through the online copy, work as whoever is
 * signed in on this PC. This PC's own robots, other PCs' servers and Adal
 * support keep everything. An employee with no role yet is an Admin.
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
      // Her password as the admin can read it again (locked with the account vault's key).
      if ((await db.schema.hasTable('users')) && !(await db.schema.hasColumn('users', 'password_seen'))) {
        await db.schema.table('users', t => t.text('password_seen').nullable())
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

// The employee signed in on this PC itself (its own window, not another computer's):
// the phones work as them (asked on 2026-11-22: "the phones have the authority of the PC").
const PC_STAFF = 'pc_staff_id'
export async function setPcStaff(db, id) {
  const now = new Date().toISOString()
  const value = id ? String(id) : null
  try {
    if (await db('settings').where({ key: PC_STAFF }).first()) await db('settings').where({ key: PC_STAFF }).update({ value, updated_at: now })
    else await db('settings').insert({ key: PC_STAFF, value, created_at: now, updated_at: now })
  } catch (e) { console.warn('[staffRoles] pc staff:', e.message) }
}
const pcStaffId = async (db) => Number((await db('settings').where({ key: PC_STAFF }).first().catch(() => null))?.value) || null

// The PC's default employee (asked on 2026-11-23: robots and normal work must not stop
// because nobody picked an employee): the last one who signed in on this PC (kept when
// they sign out), else the first Admin. A window or phone with no one signed in works as them.
const PC_DEFAULT = 'pc_default_staff_id'
export async function setPcDefaultStaff(db, id) {
  if (!id) return
  const now = new Date().toISOString()
  try {
    if (await db('settings').where({ key: PC_DEFAULT }).first()) await db('settings').where({ key: PC_DEFAULT }).update({ value: String(id), updated_at: now })
    else await db('settings').insert({ key: PC_DEFAULT, value: String(id), created_at: now, updated_at: now })
  } catch (e) { console.warn('[staffRoles] pc default staff:', e.message) }
}
export async function pcDefaultStaff(db) {
  const id = Number((await db('settings').where({ key: PC_DEFAULT }).first().catch(() => null))?.value) || null
  const user = id ? await db('users').where({ id }).first().catch(() => null) : null
  if (user) return user
  const users = await db('users').select('*').orderBy('id').catch(() => [])
  if (!users.length) return null
  const roles = await listRoles(db)
  const admin = roles.find(r => r.preset === 'admin')
  return users.find(u => (u.role_id ?? admin?.id) === admin?.id) || null
}

const header = (req, h) => req.get?.(h) ?? req.headers?.[h]
const fromBrowser = (req) => /Mozilla\//.test(String(header(req, 'user-agent') || ''))
const decode = (v) => { try { return decodeURIComponent(String(v || '')) } catch { return String(v || '') } }

/**
 * Who is asking:
 *   { kind: 'staff', user }   an employee signed in (their key, or the sign-in cookie)
 *   { kind: 'phone', user }   a phone, or a call through the online copy: whoever is
 *                             signed in on this PC (user null: no one)
 *   { kind: 'signed-out' }    a window with no one signed in: it may look, not change
 *   { kind: 'unknown' }       a key that is not ours, or an employee deleted since
 *   { kind: 'pc' }            this PC's own robots and other PCs' servers; Adal support
 */
export async function whoIsAsking(db, req) {
  const byId = async (id, kind) => {
    const user = await db('users').where({ id }).first().catch(() => null)
    return user ? { kind, user } : { kind: 'unknown' }
  }
  const relayed = !!header(req, 'x-adal-cloud') && !fromBrowser(req)
  // (The phone app names itself in its user agent: phones from before X-Adal-Phone too.)
  const phone = !!header(req, 'x-adal-phone') || /AdalKeepPhone/.test(String(header(req, 'user-agent') || '')) || (relayed && decode(header(req, 'x-adal-who')) !== 'Adal support')
  const key = header(req, 'x-adal-staff')
  if (key && !phone) {
    const d = verifyToken(String(key))
    return d?.staff ? byId(Number(d.staff), 'staff') : { kind: 'unknown' }
  }
  if (phone) {
    const id = await pcStaffId(db)
    return id ? byId(id, 'phone').then(w => w.user ? w : { kind: 'phone', user: null }) : { kind: 'phone', user: null }
  }
  if (!fromBrowser(req)) return { kind: 'pc' }
  if (req.auth?.uid) return byId(Number(req.auth.uid), 'staff')
  // This PC's own window that lost its key (signed in before staff roles came, 2026-11-22, or
  // its storage cleared): it works as whoever is signed in on this PC, like the phones. On the
  // agency's main PC every robot start was refused "Signed out" while someone was signed in.
  if (ownWindow(req)) {
    const id = (await pcStaffId(db)) || Number((await db('settings').where({ key: 'active_employee_id' }).first().catch(() => null))?.value) || null
    if (id) { const w = await byId(id, 'staff'); if (w.user) return w }
  }
  return { kind: 'signed-out' }
}

// The window on this PC itself (127.0.0.1, nothing forwarded), not another computer's.
// An office PC (a Companion on its own full copy, or standing in for the main PC) is reached
// through adal-companion.exe's door: it connects from a loopback address of its own and says who
// asks (x-adal-real-ip, X-Forwarded-For, always its own values). The PC's own window then says
// 127.0.0.1 there — before, it counted as another computer and every tick was "Signed out".
const LOOP = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/
export function ownWindow(req, env = process.env) {
  const sock = String(req.socket?.remoteAddress || '')
  let ip = sock
  if (env.ADAL_BEHIND_COMPANION === '1' && /^(::ffff:)?127\./.test(sock)) ip = String(header(req, 'x-adal-real-ip') || sock)
  if (!LOOP.test(ip)) return false
  // (X-Adal-PC from a window is only that window's own key — a Companion's window sends it with
  // every call; servers that pass calls on are not browsers and count as 'pc' before this.)
  if (['x-adal-cloud', 'forwarded', 'x-real-ip'].some(h => header(req, h) !== undefined)) return false
  const xff = header(req, 'x-forwarded-for')
  return xff === undefined || String(xff).split(',').every(a => LOOP.test(a.trim()))
}
// A window on another computer of the office that the main PC said "Yes" to (networkGate sets
// req.pcAccess): a person at an office PC ticks and unticks steps as the PC's default employee.
const approvedOfficePC = (req) => !!req.pcAccess && !req.pcAccess.sync && fromBrowser(req)

/** No employee can manage staff yet (a new agency): a window with no one signed in may do everything. */
async function noStaffManager(db) {
  const roles = await listRoles(db)
  return !roles.some(r => r.members > 0 && r.perms.manage_staff)
}

/** What the asker may do: { perms, role, user, readOnly }. */
export async function permsFor(db, req) {
  await ensureStaffRoles(db)
  const who = await whoIsAsking(db, req)
  if (who.kind === 'pc') return { perms: { ...ALL }, role: null, user: null, readOnly: false, kind: who.kind }
  if (who.user) {
    const role = await roleOf(db, who.user)
    return { perms: role.perms, role, user: who.user, readOnly: false, kind: who.kind }
  }
  if (who.kind === 'signed-out' && (await noStaffManager(db))) return { perms: { ...ALL }, role: null, user: null, readOnly: false, kind: who.kind }
  // This PC's own window, an approved office PC's window, or a phone: the PC's default employee.
  if ((who.kind === 'signed-out' && (ownWindow(req) || approvedOfficePC(req))) || who.kind === 'phone') {
    const user = await pcDefaultStaff(db)
    if (user) {
      const role = await roleOf(db, user)
      // Managing staff stays with someone who signed in.
      return { perms: { ...role.perms, manage_staff: false }, role, user, readOnly: false, kind: 'default' }
    }
  }
  return { perms: { ...NONE }, role: null, user: null, readOnly: true, kind: who.kind }
}

// Changes anyone may send, signed in or not: signing in, the window itself, "still here" calls,
// and answers to a robot already working (its captcha, a code, "done" on its human step; the
// phone's LMIS SMS code): the run was started by someone signed in, and it waits for them.
const FREE = /^\/(automations\/\d+\/(captcha|input|attention\/done)$|lmis\/sms-code$|tower\/(crash|ticket)$|employees\/device-(login|resume|logout)$|auth\/|setup\/|subscription\/|pc-access\/|mobile\/(pair|push-token)$|app\/|tutor|chat\/ping|plan\/refresh|profiles\/-?\d+\/opened$|cv\/(preview|prepare|warm|templates\/preview-html)$)|(ping|warm|typing|alive|heartbeat|seen|read)$/

// Which toggle each change needs (method, path under /api). The first match wins.
const W = '(POST|PUT|PATCH|DELETE)'
const RULES = [
  // Signing in, out and back in on a device is never stopped.
  [/^(GET|POST|PUT|PATCH|DELETE) \/employees\/device-(login|resume|logout)$/, null],
  // Her own password: she changes it herself (the route lets the admin too).
  [/^PUT \/employees\/\d+\/password$/, null],
  [/^GET \/employees\/\d+\/password$/, 'manage_staff'],
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
  [/^GET \/profiles\/\d+\/data-export$/, 'export_backup'],   // data protection: all of one candidate's data
  [/^POST \/profiles\/\d+\/erase$/, 'delete_profiles'],
  [/^GET \/audit$/, 'manage_staff'],
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

const CHANGE = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * Express guard for /api: refuses what the asker may not do (403) — a toggle
 * their role lacks ({ forbidden }), or any change from a window where no one
 * is signed in ({ signed_out }).
 */
export function staffGuard(req, res, next) {
  const perm = permNeeded(req.method, req.path)
  const change = CHANGE.has(String(req.method).toUpperCase()) && !FREE.test(req.path)
  if (!perm && !change) return next()
  const db = req.app.locals.db
  permsFor(db, req).then(async ({ perms, role, readOnly, kind }) => {
    if (perm ? perms[perm] : !readOnly) return next()
    if (readOnly) {
      // Never a dead end: who to sign in as, in one click (the window's "Sign in as …").
      const as = kind === 'phone' ? null : await pcDefaultStaff(db).catch(() => null)
      return res.status(403).json({
        ...(as ? { sign_in_as: { id: as.id, name: as.name || as.username || 'the employee' } } : {}),
        error: kind === 'phone' ? 'No one is signed in on the PC: sign in there (Employees) to make changes from the phone.'
          : 'Signed out: you can look, not change. Sign in (Employees) first.',
        signed_out: true, ...(perm ? { forbidden: perm } : {}),
      })
    }
    res.status(403).json({
      error: `Your role${role ? ` (${role.name})` : ''} cannot ${PERMS[perm]}. Ask the admin.`,
      forbidden: perm,
    })
  }).catch((e) => res.status(500).json({ error: 'Could not check your role: ' + e.message }))
}
