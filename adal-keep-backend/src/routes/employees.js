import express from 'express'
import bcrypt from 'bcryptjs'

const router = express.Router()

router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db
    const employees = await db('users')
      .where({ company_id: req.auth.companyId })
      .select('id', 'name', 'username', 'phone_whatsapp', 'phone_work', 'whatsapp_linked', 'role', 'created_at')
      .orderBy('created_at', 'desc')
    res.json(employees)
  } catch (err) {
    res.status(500).json({ error: 'ሰራተኞችን መጫን አልተቻለም' })
  }
})

router.post('/', async (req, res) => {
  if (req.auth.role !== 'owner') return res.status(403).json({ error: 'ለባለቤት ብቻ' })
  const { name, username, phone_whatsapp, phone_work, password } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'ስም ያስፈልጋል' })
  if (!username?.trim() || /\s/.test(username)) return res.status(400).json({ error: 'ትክክለኛ መለያ ስም ያስገቡ (ያለ ክፍተት)' })
  if (!password || password.length < 4) return res.status(400).json({ error: 'የይለፍ ቃል ያንስ 4 ፊደል መሆን አለበት' })

  try {
    const db = req.app.locals.db
    // FIX: Normalize phone numbers
    const normalizePhone = (p) => p ? p.replace(/\D/g, '').replace(/^0+/, '+251') : null
    const normWa = normalizePhone(phone_whatsapp)
    const normWork = normalizePhone(phone_work)

    if (await db('users').where({ username: username.trim() }).first())
      return res.status(400).json({ error: 'መለያ ስም ቀድሞ ተወስዷል' })
    if (normWa && await db('users').where({ phone_whatsapp: normWa }).first())
      return res.status(400).json({ error: 'ስልክ ቁጥር ቀድሞ ተመዝግቧል' })

    const [id] = await db('users').insert({
      name: name.trim(), username: username.trim(),
      phone_whatsapp: normWa, phone_work: normWork,
      password: await bcrypt.hash(password, 10), role: 'employee',
      company_id: req.auth.companyId, branch_id: req.auth.branchId,
    })
    res.status(201).json({ id, message: 'ሰራተኛ ተፈሯል' })
  } catch (err) {
    console.error('[employees]', err.message)
    res.status(500).json({ error: 'ሰራተኛ መፍጠር አልተቻለም: ' + err.message })
  }
})

router.put('/:id', async (req, res) => {
  if (req.auth.role !== 'owner') return res.status(403).json({ error: 'ለባለቤት ብቻ' })
  const { name, phone_whatsapp, phone_work } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'ስም ያስፈልጋል' })
  try {
    const db = req.app.locals.db
    // FIX: Normalize phone numbers
    const normalizePhone = (p) => p ? p.replace(/\D/g, '').replace(/^0+/, '+251') : null
    const normWa = normalizePhone(phone_whatsapp)
    const normWork = normalizePhone(phone_work)

    await db('users').where({ id: req.params.id, company_id: req.auth.companyId }).update({
      name: name.trim(), phone_whatsapp: normWa, phone_work: normWork,
      updated_at: new Date().toISOString(),
    })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'ማዘመን አልተቻለም' })
  }
})

router.delete('/:id', async (req, res) => {
  if (req.auth.role !== 'owner') return res.status(403).json({ error: 'ለባለቤት ብ' })
  try {
    const db = req.app.locals.db
    await db('users').where({ id: req.params.id, company_id: req.auth.companyId }).del()
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: 'መሰረዝ አልተቻለም' })
  }
})

export default router
