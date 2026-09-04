import express from 'express'
import bcrypt from 'bcryptjs'

const router = express.Router()

// ---------- LIST ----------
router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db

    // If we have a company from the token, filter by it.
    // Otherwise return all employees (no owner required).
    let query = db('users')
      .select('id', 'name', 'username', 'phone_work', 'role', 'created_at')
      .orderBy('created_at', 'desc')

    if (req.auth?.companyId) {
      query = query.where({ company_id: req.auth.companyId })
    }

    const employees = await query
    res.json(employees)
  } catch (err) {
    console.error('[employees GET]', err.message)
    res.status(500).json({ error: 'ሰራተኞችን መጫን አልተቻለም' })
  }
})

// ---------- CREATE (anyone can create) ----------
router.post('/', async (req, res) => {
  const { name, username, phone_work, password } = req.body

  if (!name?.trim()) return res.status(400).json({ error: 'ስም ያስፈልጋል' })
  if (!username?.trim() || /\s/.test(username)) return res.status(400).json({ error: 'ትክክለኛ መለያ ስም ያስገቡ (ያለ ክፍተት)' })
  if (!password || password.length < 4) return res.status(400).json({ error: 'የይለፍ ቃል ቢያንስ 4 ፊደል መሆን አለበት' })

  try {
    const db = req.app.locals.db

    // Find the only company (or the one from token)
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

    const normWork = normalizePhone(phone_work)

    if (await db('users').where({ username: username.trim() }).first()) {
      return res.status(400).json({ error: 'መለያ ስም ቀድሞ ተወስዷል' })
    }

    const [id] = await db('users').insert({
      name: name.trim(),
      username: username.trim(),
      phone_work: normWork,
      password: await bcrypt.hash(password, 10),
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

// ---------- UPDATE (anyone can update) ----------
router.put('/:id', async (req, res) => {
  const { name, phone_work, password } = req.body
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

    const update = {
      name: name.trim(),
      phone_work: normalizePhone(phone_work),
      phone_work: normalizePhone(phone_work),
      updated_at: new Date().toISOString(),
    }
    if (password && password.length >= 4) {
      update.password = await bcrypt.hash(password, 10)
    }

    await db('users').where({ id: req.params.id }).update(update)
    res.json({ success: true })
  } catch (err) {
    console.error('[employees PUT]', err.message)
    res.status(500).json({ error: 'ማዘመን አልተቻለም' })
  }
})

// ---------- DELETE (anyone can delete) ----------
router.delete('/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    await db('users').where({ id: req.params.id }).del()
    res.json({ success: true })
  } catch (err) {
    console.error('[employees DELETE]', err.message)
    res.status(500).json({ error: 'መሰረዝ አልተቻለም' })
  }
})

export default router
