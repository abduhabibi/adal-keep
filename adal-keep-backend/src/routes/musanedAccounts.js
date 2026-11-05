import multer from 'multer'
import express from 'express'
import { seal } from '../services/accountVault.js'

/**
 * Login accounts of one portal (Musaned, the visa platform): list / add /
 * edit / delete. `table` is its accounts table, `kind` its Trash kind.
 */
export function accountsRouter(table, kind) {
const router = express.Router()

router.get('/accounts', async (req, res) => {
  try {
    const rows = await req.app.locals.db(table)
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

    if (b.is_default) await db(table).update({ is_default: false })

    const [id] = await db(table).insert({
      name: String(b.name).trim(),
      username: String(b.username).trim(),
      password: seal(String(b.password)),
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
    if (upd.password) upd.password = seal(upd.password)
    if (upd.is_default) await db(table).update({ is_default: false })
    upd.updated_at = new Date().toISOString()
    await db(table).where('id', req.params.id).update(upd)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.delete('/accounts/:id', async (req, res) => {
  try {
    const { moveToTrash } = await import('../services/trash.js')
    await moveToTrash(req.app.locals.db, kind, req.params.id, req)
    res.json({ ok: true })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

  return router
}

/**
 * Musaned's authenticator per account (services/musanedTotp.js):
 *   GET    /musaned/authenticators              { accountId: { label, code, left } | null }
 *   POST   /musaned/accounts/:id/authenticator  a QR picture (field "image") or { key }
 *   DELETE /musaned/accounts/:id/authenticator
 */
const musaned = accountsRouter('musaned_accounts', 'musaned_account')
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } })
musaned.get('/authenticators', async (req, res) => {
  try {
    const { authenticatorInfo } = await import('../services/musanedTotp.js')
    const rows = await req.app.locals.db('musaned_accounts').select('id')
    res.json(Object.fromEntries(rows.map(r => [r.id, authenticatorInfo(r.id)])))
  } catch (e) { res.status(500).json({ error: e.message }) }
})
musaned.post('/accounts/:id/authenticator', upload.single('image'), async (req, res) => {
  try {
    const { saveAuthenticator } = await import('../services/musanedTotp.js')
    const acct = await req.app.locals.db('musaned_accounts').where('id', Number(req.params.id)).first('id')
    if (!acct) return res.status(404).json({ error: 'No such Musaned account' })
    res.json(await saveAuthenticator(acct.id, { image: req.file?.buffer || null, text: req.body?.key || '' }))
  } catch (e) { res.status(400).json({ error: e.message }) }
})
musaned.delete('/accounts/:id/authenticator', async (req, res) => {
  try { (await import('../services/musanedTotp.js')).removeAuthenticator(Number(req.params.id)); res.json({ ok: true }) }
  catch (e) { res.status(500).json({ error: e.message }) }
})
export default musaned