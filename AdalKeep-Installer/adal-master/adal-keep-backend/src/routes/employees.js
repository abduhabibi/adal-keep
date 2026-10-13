import express from 'express'
import bcrypt from 'bcryptjs'
import crypto from 'crypto'
import { signToken } from '../services/tenancy.js'

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
    let query = db('users')
      .select('id', 'name', 'username', 'phone_work', 'role', 'created_at', 'device_serial')
      .orderBy('created_at', 'desc')
    if (req.auth?.companyId) query = query.where({ company_id: req.auth.companyId })
    res.json(await query)
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
    const [id] = await db('users').insert({
      name: name.trim(),
      username: username.trim(),
      phone_work: normalizePhone(phone_work),
      password: await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10),
      role: 'employee',
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
    const employeeId = Number(req.body.employeeId)
    const deviceSerial = String(req.body.deviceSerial || '').trim()
    if (!employeeId || !deviceSerial) {
      return res.status(400).json({ error: 'employeeId and deviceSerial required' })
    }
    const user = await db('users').where({ id: employeeId }).first()
    if (!user) return res.status(404).json({ error: 'ሰራተኛ አልተገኘም' })

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
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role || 'employee',
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

router.delete('/:id', async (req, res) => {
  try {
    await req.app.locals.db('users').where({ id: req.params.id }).del()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'መሰረዝ አልተቻለም' })
  }
})

export default router
