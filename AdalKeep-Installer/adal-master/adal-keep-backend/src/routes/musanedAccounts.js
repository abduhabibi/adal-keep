import express from 'express'
const router = express.Router()

router.get('/accounts', async (req, res) => {
  try {
    const rows = await req.app.locals.db('musaned_accounts')
      .orderBy('is_default', 'desc').orderBy('name')
    res.json(rows)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.post('/accounts', async (req, res) => {
  try {
    const db = req.app.locals.db
    const b = req.body || {}
    if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' })
    if (!b.username || !String(b.username).trim()) return res.status(400).json({ error: 'Username is required' })
    if (!b.password || !String(b.password).trim()) return res.status(400).json({ error: 'Password is required' })

    if (b.is_default) await db('musaned_accounts').update({ is_default: false })

    const [id] = await db('musaned_accounts').insert({
      name: String(b.name).trim(),
      username: String(b.username).trim(),
      password: String(b.password),
      phone: b.phone || '',
      notes: b.notes || '',
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
    for (const k of ['name','username','password','phone','notes','is_default']) {
      if (req.body[k] !== undefined) upd[k] = req.body[k]
    }
    if (upd.is_default) await db('musaned_accounts').update({ is_default: false })
    upd.updated_at = new Date().toISOString()
    await db('musaned_accounts').where('id', req.params.id).update(upd)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/accounts/:id', async (req, res) => {
  try {
    await req.app.locals.db('musaned_accounts').where('id', req.params.id).del()
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

export default router