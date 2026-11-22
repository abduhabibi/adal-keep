import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { signToken } from '../services/tenancy.js'
import { setActiveEmployee, clearActiveEmployee } from '../services/activeEmployee.js'
import { ensureStaffRoles, listRoles, roleOf, rolesInUse, staffToken } from '../services/staffRoles.js'

const router = express.Router()

const setTokenCookie = (res, t) =>
  res.setHeader(
    'Set-Cookie',
    `adal_token=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
  )

async function ensureDeviceColumn(db) {
  try {
    const cols = await db('users').columnInfo()
    if (!cols.device_serial) {
      await db.schema.table('users', (t) => t.string('device_serial', 128).nullable())
    }
  } catch (e) {
    console.warn('[employees] device_serial:', e.message)
  }
}

router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    await ensureDeviceColumn(db)
    await ensureStaffRoles(db)
    let query = db('users')
      .select('id', 'name', 'username', 'phone_work', 'role', 'role_id', 'pin_set', 'created_at', 'device_serial')
      .orderBy('created_at', 'desc')
    if (req.auth?.companyId) query = query.where({ company_id: req.auth.companyId })
    // Each one's staff role (none yet: Admin) — the online copy carries it too.
    const roles = await listRoles(db)
    const admin = roles.find(r => r.preset === 'admin')
    res.json((await query).map(u => {
      const r = roles.find(x => x.id === u.role_id) || admin
      return { ...u, role_id: r?.id ?? null, role_name: r?.name || 'Admin', pin_set: !!u.pin_set }
    }))
  } catch (err) {
    console.error('[employees GET]', err.message)
    res.status(500).json({ error: 'ሰራተኞችን መጫን አልተቻለም' })
  }
})

/** name + username only — no password */
router.post('/', async (req, res) => {
  const { name, username, phone_work } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'ስም ያስፈልጋል' })
  if (!username?.trim() || /\s/.test(username)) {
    return res.status(400).json({ error: 'ትክክለኛ መለያ ስም ያስገቡ (ያለ ክፍተት)' })
  }
  try {
    const db = req.app.locals.db
    await ensureDeviceColumn(db)
    let companyId = req.auth?.companyId
    let branchId = req.auth?.branchId
    if (!companyId) {
      const company = await db('companies').first()
      if (!company) return res.status(400).json({ error: 'ምንም ኩባንያ አልተዋቀም' })
      companyId = company.id
      const branch = await db('branches').where({ company_id: companyId }).first()
      branchId = branch?.id || null
    }
    const normalizePhone = (p) => {
      if (!p) return null
      const digits = String(p).replace(/\D/g, '')
      if (digits.startsWith('251')) return '+' + digits
      if (digits.startsWith('0')) return '+251' + digits.slice(1)
      return digits ? '+251' + digits : null
    }
    if (await db('users').where({ username: username.trim() }).first()) {
      return res.status(400).json({ error: 'መለያ ስም ቀድሞ ተወስዷል' })
    }
    // The staff role picked for her (none picked: Admin, as before).
    const roles = await listRoles(db)
    const role = roles.find(r => r.id === Number(req.body.role_id)) || roles.find(r => r.preset === 'admin')
    const [id] = await db('users').insert({
      name: name.trim(),
      username: username.trim(),
      phone_work: normalizePhone(phone_work),
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      role: 'employee',
      role_id: role?.id ?? null,
      company_id: companyId,
      branch_id: branchId,
    })
    res.status(201).json({ id, message: 'ሰራተኛ ተፈጥሯል' })
  } catch (err) {
    console.error('[employees POST]', err.message)
    res.status(500).json({ error: 'ሰራተኛ መፍጠር አልተቻለም: ' + err.message })
  }
})

router.post('/device-login', async (req, res) => {
  try {
    const db = req.app.locals.db
    await ensureDeviceColumn(db)
    await ensureStaffRoles(db)
    const employeeId = Number(req.body.employeeId)
    const deviceSerial = String(req.body.deviceSerial || '').trim()
    if (!employeeId || !deviceSerial) {
      return res.status(400).json({ error: 'employeeId and deviceSerial required' })
    }
    const user = await db('users').where({ id: employeeId }).first()
    if (!user) return res.status(404).json({ error: 'ሰራተኛ አልተገኘም' })
    // Staff roles in use: signing in as someone who manages staff asks for
    // their PIN (when they have one), so a Data entry employee cannot just
    // click the admin's card.
    const role = await roleOf(db, user)
    if (role?.perms.manage_staff && user.pin_set && (await rolesInUse(db))) {
      const pin = String(req.body.pin || '').trim()
      if (!pin) return res.status(401).json({ error: `${user.name}'s PIN`, needs_pin: true })
      if (!(await bcrypt.compare(pin, user.password || ''))) return res.status(401).json({ error: 'Wrong PIN', needs_pin: true })
    }

    const other = await db('users')
      .where({ device_serial: deviceSerial })
      .whereNot({ id: employeeId })
      .first()
    if (other) {
      await db('users').where({ id: other.id }).update({ device_serial: null })
    }
    // Allow this PC to take over the employee session (office PCs share staff)
    if (user.device_serial && user.device_serial !== deviceSerial) {
      console.warn('[device-login] rebind employee', employeeId, 'from other device')
    }
    await db('users').where({ id: employeeId }).update({
      device_serial: deviceSerial,
      updated_at: new Date().toISOString(),
    })
    await setActiveEmployee(db, user)
    setTokenCookie(
      res,
      signToken({
        uid: user.id,
        companyId: user.company_id,
        branchId: user.branch_id,
        role: user.role || 'employee',
      })
    )
    res.json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role || 'employee',
        role_id: role?.id ?? null,
        role_name: role?.name || null,
        staff_token: staffToken(user),
      },
    })
  } catch (err) {
    console.error('[device-login]', err.message)
    res.status(500).json({ error: err.message })
  }
})

router.post('/device-resume', async (req, res) => {
  try {
    const db = req.app.locals.db
    await ensureDeviceColumn(db)
    const deviceSerial = String(req.body.deviceSerial || '').trim()
    if (!deviceSerial) return res.json({ user: null })
    const user = await db('users').where({ device_serial: deviceSerial }).first()
    if (!user) return res.json({ user: null })
    await setActiveEmployee(db, user)
    setTokenCookie(
      res,
      signToken({
        uid: user.id,
        companyId: user.company_id,
        branchId: user.branch_id,
        role: user.role || 'employee',
      })
    )
    const role = await roleOf(db, user)
    res.json({
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role || 'employee',
        role_id: role?.id ?? null,
        role_name: role?.name || null,
        staff_token: staffToken(user),
      },
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/device-logout', async (req, res) => {
  try {
    const db = req.app.locals.db
    await ensureDeviceColumn(db)
    const deviceSerial = String(req.body.deviceSerial || '').trim()
    if (deviceSerial) {
      await db('users').where({ device_serial: deviceSerial }).update({ device_serial: null })
    }
    await clearActiveEmployee(db)
    res.setHeader('Set-Cookie', 'adal_token=; Path=/; HttpOnly; Max-Age=0')
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.put('/:id', async (req, res) => {
  const { name, phone_work } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'ስም ያስፈልጋል' })
  try {
    const db = req.app.locals.db
    const normalizePhone = (p) => {
      if (!p) return null
      const digits = String(p).replace(/\D/g, '')
      if (digits.startsWith('251')) return '+' + digits
      if (digits.startsWith('0')) return '+251' + digits.slice(1)
      return digits ? '+251' + digits : null
    }
    await db('users').where({ id: req.params.id }).update({
      name: name.trim(),
      phone_work: normalizePhone(phone_work),
      updated_at: new Date().toISOString(),
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'ማዘመን አልተቻለም' })
  }
})

/**
 * Her sign-in for other computers (an Adal Companion asks "Sign in to the main
 * PC"): a username of 5 letters and a PIN of 6 digits. Set only on the main PC
 * itself — never from a phone or the online copy. The PIN is kept hashed; it is
 * shown once, here, to write down.
 */
router.put('/:id/sign-in', async (req, res) => {
  try {
    const { onThisPC, fromCompanion } = await import('./trash.js')
    if (!onThisPC(req) && !fromCompanion(req)) return res.status(403).json({ error: 'Set it on the main PC or one of its Companions' })
    const db = req.app.locals.db
    const username = String(req.body?.username || '').trim().toLowerCase()
    const pin = String(req.body?.pin || '').trim()
    if (!/^[a-z]{5}$/.test(username)) return res.status(400).json({ error: 'The username is 5 letters (a–z), e.g. abebe' })
    if (!/^\d{6}$/.test(pin)) return res.status(400).json({ error: 'The PIN is 6 digits' })
    const user = await db('users').where({ id: req.params.id }).first()
    if (!user) return res.status(404).json({ error: 'Employee not found' })
    const taken = await db('users').whereRaw('LOWER(username) = ?', [username]).whereNot({ id: user.id }).first()
    if (taken) return res.status(400).json({ error: `"${username}" is someone else's username — pick another` })
    await ensureStaffRoles(db)
    await db('users').where({ id: user.id }).update({ username, password: await bcrypt.hash(pin, 10), pin_set: true, updated_at: new Date().toISOString() })
    res.json({ success: true, username })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { moveToTrash } = await import('../services/trash.js')
    await moveToTrash(req.app.locals.db, 'employee', req.params.id, req)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'መሰረዝ አልተቻለም' })
  }
})

export default router
