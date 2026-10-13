import express from 'express'
const router = express.Router()

router.get('/accounts', async (req, res) => {
  try {
    const rows = await req.app.locals.db('lmis_accounts').orderBy('is_default', 'desc').orderBy('name')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/accounts', async (req, res) => {
  try {
    const db = req.app.locals.db
    const b = req.body || {}
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' })
    if (!b.phone || !String(b.phone).trim()) return res.status(400).json({ error: 'Phone is required' })
    if (!b.password || !String(b.password).trim()) return res.status(400).json({ error: 'Password is required' })

    if (b.is_default) await db('lmis_accounts').update({ is_default: false })

    const [id] = await db('lmis_accounts').insert({
      name: String(b.name).trim(),
      phone: String(b.phone).trim(),
      login_value: String(b.phone).trim(),      // phone is the login
      password: String(b.password),
      agency_name: b.agency_name || '',
      is_default: !!b.is_default,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    res.json({ ok: true, id })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.patch('/accounts/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const upd = {}
    for (const k of ['name', 'phone', 'password', 'agency_name', 'is_default']) {
      if (req.body[k] !== undefined) upd[k] = req.body[k]
    }
    // keep login_value in sync with phone
    if (upd.phone) upd.login_value = upd.phone
    if (upd.is_default) await db('lmis_accounts').update({ is_default: false })
    upd.updated_at = new Date().toISOString()
    await db('lmis_accounts').where('id', req.params.id).update(upd)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/accounts/:id', async (req, res) => {
  try {
    await req.app.locals.db('lmis_accounts').where('id', req.params.id).del()
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router