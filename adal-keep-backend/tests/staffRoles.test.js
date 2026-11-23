import test from 'node:test'
import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import fs from 'fs'
import os from 'os'
import path from 'path'

process.env.ACCOUNT_VAULT_KEY = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vault-')), 'k')

const { default: express } = await import('express')
const { default: knex } = await import('knex')
const { ensureTenancySchema } = await import('../src/services/tenancy.js')
const { staffGuard, permNeeded, listRoles, staffToken, ensureStaffRoles, setPcStaff } = await import('../src/services/staffRoles.js')
const { default: staffRolesRouter } = await import('../src/routes/staffRoles.js')
const { default: employeesRouter } = await import('../src/routes/employees.js')

async function office() {
  const db = knex({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  await ensureTenancySchema(db)
  await db.schema.createTable('settings', t => { t.string('key'); t.text('value'); t.timestamps(true, true) })
  await db('companies').insert({ name: 'Test agency' })
  // Two employees from before roles: neither has one.
  await ensureStaffRoles(db)
  await db('users').insert([{ name: 'Abebe', username: 'abebe', role: 'employee', company_id: 1 }, { name: 'Sara', username: 'sara', role: 'employee', company_id: 1 }])
  const app = express()
  app.use(express.json())
  app.locals.db = db
  app.use('/api', staffGuard)
  app.use('/api', staffRolesRouter)
  app.use('/api/employees', employeesRouter)
  // Stand-ins for the real routes: each answers 200 when the guard lets it through.
  const ok = (req, res) => res.json({ ok: true })
  app.delete('/api/profiles/:id', ok)
  app.put('/api/profiles/:id', ok)
  app.post('/api/profiles', ok)
  app.post('/api/profiles/:id/fields/:f/upload', ok)
  app.post('/api/settings', ok)
  app.put('/api/cv/templates/:id/content', ok)
  app.post('/api/profiles/:id/automations/:wf/start', ok)
  app.post('/api/backup/run', ok)
  app.post('/api/automations/:id/captcha', ok)
  app.post('/api/automations/:id/input', ok)
  app.post('/api/lmis/sms-code', ok)
  app.post('/api/trash/empty', ok)
  const server = app.listen(0)
  const base = `http://127.0.0.1:${server.address().port}/api`
  // A window (a browser) unless { pc: true } (this PC's robots, another PC's server).
  const call = async (method, path, { as, body, token, pc, phone, relayed, who } = {}) => {
    const headers = { 'content-type': 'application/json', 'user-agent': pc || relayed ? 'node' : 'Mozilla/5.0 Chrome' }
    if (phone) headers['x-adal-phone'] = '1'
    if (relayed) { headers['x-adal-cloud'] = '1'; headers['x-adal-who'] = encodeURIComponent(who || 'Hana (phone)') }
    if (as) headers['x-adal-staff'] = staffToken(await db('users').where({ name: as }).first())
    if (token) headers['x-adal-staff'] = token
    const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, data: await r.json().catch(() => null) }
  }
  const roleId = async (preset) => (await listRoles(db)).find(r => r.preset === preset).id
  return { db, base, call, roleId, close: async () => { server.close(); await db.destroy() } }
}

test('which toggle each change needs', () => {
  assert.equal(permNeeded('DELETE', '/profiles/12'), 'delete_profiles')
  assert.equal(permNeeded('PUT', '/profiles/12'), null)
  assert.equal(permNeeded('POST', '/profiles/12/fields/3/upload'), null)
  assert.equal(permNeeded('POST', '/trash/4/purge'), 'delete_profiles')
  assert.equal(permNeeded('POST', '/trash/4/restore'), null)
  assert.equal(permNeeded('PATCH', '/cv/templates/2'), 'edit_templates')
  assert.equal(permNeeded('POST', '/cv/templates/preview-html'), null)
  assert.equal(permNeeded('POST', '/cv/generate'), null)
  assert.equal(permNeeded('POST', '/profiles/1/automations/lmis/start'), 'run_robots')
  assert.equal(permNeeded('PUT', '/settings'), 'change_settings')
  assert.equal(permNeeded('GET', '/settings'), null)
  assert.equal(permNeeded('PATCH', '/musaned/accounts/3'), 'change_settings')
  assert.equal(permNeeded('POST', '/employees'), 'manage_staff')
  assert.equal(permNeeded('PUT', '/employees/3/role'), 'manage_staff')
  assert.equal(permNeeded('POST', '/employees/device-login'), null)
  assert.equal(permNeeded('POST', '/staff-roles'), 'manage_staff')
  assert.equal(permNeeded('POST', '/backup/run'), 'export_backup')
  assert.equal(permNeeded('POST', '/backup/settings'), 'change_settings')
  assert.equal(permNeeded('GET', '/branch/export'), 'export_backup')
})

test('the three ready roles; employees from before are Admins and can do everything', async () => {
  const o = await office()
  const { data } = await o.call('GET', '/staff-roles')
  assert.deepEqual(data.roles.map(r => r.name), ['Admin', 'Office', 'Data entry'])
  const [admin, off, entry] = data.roles
  assert.ok(Object.values(admin.perms).every(Boolean))
  assert.deepEqual(off.perms, { delete_profiles: false, edit_templates: false, run_robots: true, change_settings: false, manage_staff: false, export_backup: true })
  assert.ok(Object.values(entry.perms).every(v => v === false))
  assert.equal(admin.members, 2)
  const emps = (await o.call('GET', '/employees')).data
  assert.ok(emps.every(e => e.role_name === 'Admin'))
  for (const [m, p] of [['DELETE', '/profiles/1'], ['POST', '/settings'], ['POST', '/backup/run'], ['POST', '/trash/empty']]) {
    assert.equal((await o.call(m, p, { as: 'Abebe' })).status, 200, `${m} ${p}`)
  }
  await o.close()
})

test('Data entry: profiles and uploads only — the server refuses the rest', async () => {
  const o = await office()
  const entry = await o.roleId('data_entry')
  assert.equal((await o.call('PUT', '/employees/2/role', { as: 'Abebe', body: { role_id: entry } })).status, 200)
  assert.equal((await o.call('POST', '/profiles', { as: 'Sara' })).status, 200)
  assert.equal((await o.call('PUT', '/profiles/1', { as: 'Sara' })).status, 200)
  assert.equal((await o.call('POST', '/profiles/1/fields/2/upload', { as: 'Sara' })).status, 200)
  for (const [m, p, perm] of [['DELETE', '/profiles/1', 'delete_profiles'], ['POST', '/settings', 'change_settings'],
    ['PUT', '/cv/templates/1/content', 'edit_templates'], ['POST', '/profiles/1/automations/lmis/start', 'run_robots'],
    ['POST', '/backup/run', 'export_backup'], ['POST', '/staff-roles', 'manage_staff'], ['PUT', '/employees/2/role', 'manage_staff']]) {
    const r = await o.call(m, p, { as: 'Sara', body: { role_id: 1, name: 'x' } })
    assert.equal(r.status, 403, `${m} ${p}`)
    assert.equal(r.data.forbidden, perm)
    assert.match(r.data.error, /Data entry/)
  }
  // Her own key cannot be changed to someone else's: a made-up key gets nothing.
  assert.equal((await o.call('DELETE', '/profiles/1', { token: 'eyJzdGFmZiI6MX0.bad' })).status, 403)
  // This PC's own robots, other PCs' servers: as before.
  assert.equal((await o.call('DELETE', '/profiles/1', { pc: true })).status, 200)
  await o.close()
})

test('Office: robots and backups, not deleting, templates, settings or staff', async () => {
  const o = await office()
  await o.db('users').where({ name: 'Sara' }).update({ role_id: await o.roleId('office') })
  assert.equal((await o.call('POST', '/profiles/1/automations/lmis/start', { as: 'Sara' })).status, 200)
  assert.equal((await o.call('POST', '/backup/run', { as: 'Sara' })).status, 200)
  assert.equal((await o.call('DELETE', '/profiles/1', { as: 'Sara' })).status, 403)
  assert.equal((await o.call('POST', '/trash/empty', { as: 'Sara' })).status, 403)
  assert.equal((await o.call('PUT', '/cv/templates/1/content', { as: 'Sara' })).status, 403)
  assert.equal((await o.call('POST', '/settings', { as: 'Sara' })).status, 403)
  assert.equal((await o.call('POST', '/employees', { as: 'Sara', body: { name: 'New', username: 'new' } })).status, 403)
  const me = (await o.call('GET', '/staff-roles/me', { as: 'Sara' })).data
  assert.equal(me.role.name, 'Office')
  assert.equal(me.perms.run_robots, true)
  await o.close()
})

test('the admin makes a role with its own toggles; Admin stays everything; a role in use stays', async () => {
  const o = await office()
  const made = await o.call('POST', '/staff-roles', { as: 'Abebe', body: { name: 'Robots only', perms: { run_robots: true, nonsense: true } } })
  assert.equal(made.status, 201)
  const role = (await o.call('GET', '/staff-roles')).data.roles.find(r => r.name === 'Robots only')
  assert.deepEqual(Object.entries(role.perms).filter(([, v]) => v).map(([k]) => k), ['run_robots'])
  assert.equal((await o.call('POST', '/staff-roles', { as: 'Abebe', body: { name: 'robots ONLY' } })).status, 400)
  assert.equal((await o.call('PUT', `/staff-roles/${await o.roleId('admin')}`, { as: 'Abebe', body: { perms: {} } })).status, 400)
  assert.equal((await o.call('PUT', `/staff-roles/${role.id}`, { as: 'Abebe', body: { perms: { run_robots: true, delete_profiles: true } } })).status, 200)
  await o.call('PUT', '/employees/2/role', { as: 'Abebe', body: { role_id: role.id } })
  assert.equal((await o.call('DELETE', '/profiles/1', { as: 'Sara' })).status, 200)
  assert.equal((await o.call('POST', '/settings', { as: 'Sara' })).status, 403)
  assert.equal((await o.call('DELETE', `/staff-roles/${role.id}`, { as: 'Abebe' })).status, 400)
  assert.equal((await o.call('DELETE', `/staff-roles/${await o.roleId('office')}`, { as: 'Abebe' })).status, 400)
  // A new employee gets the role picked for her (none picked: Admin).
  await o.call('POST', '/employees', { as: 'Abebe', body: { name: 'Hana', username: 'hana', password: 'pass1', role_id: await o.roleId('data_entry') } })
  await o.call('POST', '/employees', { as: 'Abebe', body: { name: 'Lily', username: 'lily', password: 'pass2' } })
  const emps = (await o.call('GET', '/employees')).data
  assert.equal(emps.find(e => e.name === 'Hana').role_name, 'Data entry')
  assert.equal(emps.find(e => e.name === 'Lily').role_name, 'Admin')
  await o.close()
})

test('signing in asks for the password; a device still signed in is not asked', async () => {
  const o = await office()
  await o.db('users').where({ name: 'Abebe' }).update({ password: await bcrypt.hash('123456', 4), pin_set: true })
  const login = (body) => o.call('POST', '/employees/device-login', { body: { employeeId: 1, deviceSerial: 'pc-1', ...body } })
  assert.equal((await login({})).data.needs_password, true)
  assert.equal((await login({ password: '000000' })).status, 401)
  const ok = await login({ password: '123456' })
  assert.equal(ok.status, 200)
  assert.ok(ok.data.user.staff_token)
  assert.equal(ok.data.user.role_name, 'Admin')
  // Still signed in on that device (device-resume): not asked again.
  assert.equal((await o.call('POST', '/employees/device-resume', { body: { deviceSerial: 'pc-1' } })).data.user.name, 'Abebe')
  // Sara, from before passwords (none set yet): one click until the admin sets one.
  assert.equal((await o.call('POST', '/employees/device-login', { body: { employeeId: 2, deviceSerial: 'pc-2' } })).status, 200)
  await o.close()
})

test('signed out: works as the PC\'s default employee; staff only after signing in; a new agency may do everything', async () => {
  const o = await office()
  // Nobody signed in: the first Admin (Abebe) is the default — robots and normal work go on.
  for (const [m, p] of [['POST', '/profiles'], ['PUT', '/profiles/1'], ['POST', '/profiles/1/fields/2/upload'], ['POST', '/profiles/1/automations/musaned_add_candidate/start'], ['POST', '/settings']]) {
    assert.equal((await o.call(m, p, { body: {} })).status, 200, `${m} ${p}`)
  }
  assert.equal((await o.call('POST', '/employees', { body: { name: 'X', username: 'x', password: 'abcd' } })).data.forbidden, 'manage_staff')
  assert.equal((await o.call('GET', '/employees')).status, 200)
  // Sara signs in on this PC, then out: she stays the default, with her role.
  await o.db('users').where({ name: 'Sara' }).update({ role_id: await o.roleId('data_entry') })
  assert.equal((await o.call('POST', '/employees/device-login', { pc: true, body: { employeeId: 2, deviceSerial: 'pc-9' } })).status, 200)
  await setPcStaff(o.db, null)
  assert.equal((await o.call('PUT', '/profiles/1', { body: {} })).status, 200)
  assert.equal((await o.call('POST', '/profiles/1/automations/x/start')).data.forbidden, 'run_robots')
  const me = (await o.call('GET', '/staff-roles/me')).data
  assert.equal(me.perms.run_robots, false)
  // No employee at all: looking only.
  await o.db('settings').del(); await o.db('users').del()
  assert.equal((await o.call('PUT', '/profiles/1')).status, 200)   // (no employee can manage staff: a new agency)
  await o.close()
})

test('signed out: the first Admin is the default when no one ever signed in on this PC', async () => {
  const o = await office()
  const entry = await o.roleId('data_entry')
  await o.db('users').update({ role_id: entry })
  await o.db('users').insert({ name: 'Boss', username: 'boss', role: 'employee', company_id: 1 })   // no role: Admin
  // The first Admin is Boss: works as Boss.
  assert.equal((await o.call('POST', '/profiles')).status, 200)
  assert.equal((await o.call('DELETE', '/profiles/1')).status, 200)
  await o.close()
})

test('the admin sets a password, can read it and change it; she changes her own', async () => {
  const o = await office()
  assert.equal((await o.call('POST', '/employees', { as: 'Abebe', body: { name: 'Hana', username: 'hana' } })).status, 400)
  assert.equal((await o.call('POST', '/employees', { as: 'Abebe', body: { name: 'Hana', username: 'hana', password: 'hana2026', role_id: await o.roleId('data_entry') } })).status, 201)
  assert.equal((await o.call('GET', '/employees/3/password', { as: 'Abebe' })).data.password, 'hana2026')
  assert.equal((await o.call('GET', '/employees/3/password', { as: 'Hana' })).status, 403)
  assert.equal((await o.call('POST', '/employees/device-login', { body: { employeeId: 3, deviceSerial: 'd', password: 'hana2026' } })).status, 200)
  // Her own: yes. Someone else's: no.
  assert.equal((await o.call('PUT', '/employees/3/password', { as: 'Hana', body: { password: 'mine-now' } })).status, 200)
  assert.equal((await o.call('PUT', '/employees/1/password', { as: 'Hana', body: { password: 'taken' } })).status, 403)
  assert.equal((await o.call('GET', '/employees/3/password', { as: 'Abebe' })).data.password, 'mine-now')
  assert.equal((await o.call('PUT', '/employees/3/password', { as: 'Abebe', body: { password: 'reset-1' } })).status, 200)
  assert.equal((await o.call('POST', '/employees/device-login', { body: { employeeId: 3, deviceSerial: 'd', password: 'mine-now' } })).status, 401)
  assert.equal((await o.call('POST', '/employees/device-login', { body: { employeeId: 3, deviceSerial: 'd', password: 'reset-1' } })).status, 200)
  assert.ok(!(await o.call('GET', '/employees')).data.some(e => 'password' in e || 'password_seen' in e))
  await o.close()
})

test('phones and the online copy work as whoever is signed in on the PC', async () => {
  const o = await office()
  await o.db('users').where({ name: 'Sara' }).update({ role_id: await o.roleId('data_entry') })
  // No one signed in on the PC: the phone works as the PC's default employee (the first Admin).
  assert.equal((await o.call('POST', '/profiles', { phone: true })).status, 200)
  assert.equal((await o.call('POST', '/profiles', { relayed: true })).status, 200)
  await setPcStaff(o.db, 2)   // Sara signs in on the PC
  assert.equal((await o.call('POST', '/profiles', { phone: true })).status, 200)
  assert.equal((await o.call('DELETE', '/profiles/1', { phone: true })).data.forbidden, 'delete_profiles')
  // A key of its own on the phone does not count: the PC decides.
  assert.equal((await o.call('DELETE', '/profiles/1', { phone: true, as: 'Abebe' })).status, 403)
  // The phone app as installed (its user agent says so).
  assert.equal((await fetch(o.base + '/profiles', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 (Linux; Android 14; wv) AdalKeepPhone' } })).status, 200)
  await setPcStaff(o.db, 1)   // the admin signs in on the PC
  assert.equal((await o.call('DELETE', '/profiles/1', { relayed: true })).status, 200)
  // Adal support (Adal Keep Admin) through the online copy: as before.
  await setPcStaff(o.db, null)
  assert.equal((await o.call('DELETE', '/profiles/1', { relayed: true, who: 'Adal support' })).status, 200)
  await o.close()
})

test("this PC's own window without its key works as whoever is signed in on the PC; robots' answers always pass", async () => {
  const o = await office()
  await o.db('users').where({ name: 'Sara' }).update({ role_id: await o.roleId('office') })
  // No one signed in: looking only, but a robot already working may be answered.
  assert.equal((await o.call('POST', '/profiles/1/automations/musaned-add/start')).data.signed_out, true)
  // Sara signed in on this PC before staff roles (only the active employee was kept), the window has no key:
  await o.db('settings').insert({ key: 'active_employee_id', value: '2' })
  assert.equal((await o.call('POST', '/profiles/1/automations/musaned-add/start')).status, 200)
  assert.equal((await o.call('DELETE', '/profiles/1')).data.forbidden, 'delete_profiles')
  // Signed in now (pc staff) as the admin: that one counts.
  await setPcStaff(o.db, 1)
  assert.equal((await o.call('DELETE', '/profiles/1')).status, 200)
  // Signed out on the PC: looking only again.
  assert.equal((await o.call('POST', '/employees/device-logout', { body: {} })).status, 200)
  assert.equal((await o.call('POST', '/profiles')).data.signed_out, true)
  // Another computer's window (forwarded) never borrows the PC's sign-in.
  await setPcStaff(o.db, 1)
  const r = await fetch(o.base + '/profiles', { method: 'POST', headers: { 'user-agent': 'Mozilla/5.0 Chrome', 'x-forwarded-for': '192.168.1.9' } })
  assert.equal(r.status, 403)
  await o.close()
})

test("answers to a robot already working are never refused (signed out, or the phone's LMIS code)", async () => {
  const o = await office()
  assert.equal((await o.call('POST', '/automations/12/captcha')).status, 200)
  assert.equal((await o.call('POST', '/automations/12/input')).status, 200)
  assert.equal((await o.call('POST', '/lmis/sms-code', { phone: true })).status, 200)
  assert.equal((await o.call('POST', '/automations/12/resume')).status, 403)   // starting again is a change
  await o.close()
})
