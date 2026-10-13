import express from 'express'
import bcrypt from 'bcryptjs'

const router = express.Router()

router.post('/register', async (req, res) => {
  const { name, username, phone_work, password } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'ስም ያስፈልጋል' })
  if (!username?.trim() || /\s/.test(username)) return res.status(400).json({ error: 'ትክክለኛ መለያ ስም ያስገቡ (ያለ ክፍተት)' })
  if (!password || password.length < 4) return res.status(400).json({ error: 'የይለፍ ቃል ቢያንስ 4 ፊደል መሆን አለበት' })

  try {
    const db = req.app.locals.db
    const company = await db('companies').first()
    if (!company) return res.status(400).json({ error: 'ምንም ኩባንያ አልተዋቀም' })
    const branch = await db('branches').where({ company_id: company.id }).first()

    // FIX: Normalize phone numbers before checking
    const normalizePhone = (p) => p ? p.replace(/\D/g, '').replace(/^0+/, '+251') : null
    const normWork = normalizePhone(phone_work)

    if (await db('users').where({ username: username.trim() }).first())
      return res.status(400).json({ error: 'መለያ ስም ቀድሞ ተወስዷል' })

    const [id] = await db('users').insert({
      name: name.trim(),
      username: username.trim(),
      phone_work: normWork,
      password: await bcrypt.hash(password, 10),
      role: 'employee',
      company_id: company.id,
      branch_id: branch?.id || null,
    })
    res.status(201).json({ id, message: 'ተመዝግቧል' })
  } catch (err) {
    console.error('[register]', err.message)
    res.status(500).json({ error: 'ምዝገባ አልተቻለም: ' + err.message })
  }
})

export default router
