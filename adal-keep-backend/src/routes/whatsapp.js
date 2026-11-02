/**
 * /api/whatsapp — the agency's WhatsApp (Settings → WhatsApp) and the CVs a
 * person sends to agents from a profile.
 */
import express from 'express'
import { state, connect, logout, listChats, chatForNumber, agentRow, sendCV, sendsOf, onChosen } from '../services/whatsapp.js'

const router = express.Router()
const fail = (res, e) => res.status(400).json({ error: e.message })
const now = () => new Date().toISOString()

router.get('/whatsapp', (req, res) => res.json(state))
router.post('/whatsapp/connect', async (req, res) => { try { res.json(await connect(req.app.locals.db)) } catch (e) { fail(res, e) } })
router.post('/whatsapp/logout', async (req, res) => { try { await logout(); res.json(state) } catch (e) { fail(res, e) } })
router.get('/whatsapp/chats', async (req, res) => { try { res.json(await listChats()) } catch (e) { fail(res, e) } })

router.get('/whatsapp/agents', async (req, res) => {
  const db = req.app.locals.db
  const agents = (await db('whatsapp_agents').orderBy('name')).map(agentRow)
  const counts = await db('whatsapp_sends').select('agent_id', 'status').count('* as n').groupBy('agent_id', 'status')
  for (const a of agents) a.counts = Object.fromEntries(counts.filter(c => c.agent_id === a.id).map(c => [c.status, Number(c.n)]))
  res.json(agents)
})

async function agentBody(b) {
  const row = {}
  if (b.name !== undefined) row.name = String(b.name).trim().slice(0, 120)
  if (b.chat_id) row.chat_id = String(b.chat_id)
  else if (b.number) row.chat_id = await chatForNumber(b.number)
  if (b.template_ids !== undefined) row.template_ids = JSON.stringify((b.template_ids || []).map(Number).filter(Boolean))
  if (b.musaned_office !== undefined) row.musaned_office = String(b.musaned_office || '').trim().slice(0, 200)
  if (b.active !== undefined) row.active = b.active ? 1 : 0
  return row
}

router.post('/whatsapp/agents', async (req, res) => {
  try {
    const db = req.app.locals.db
    const row = await agentBody(req.body || {})
    if (!row.name) throw new Error('Type the agent\'s name')
    if (!row.chat_id) throw new Error('Pick the agent\'s chat or type the number')
    const [id] = await db('whatsapp_agents').insert({ template_ids: '[]', active: 1, ...row, created_at: now(), updated_at: now() })
    res.json(agentRow(await db('whatsapp_agents').where('id', id).first()))
  } catch (e) { fail(res, e) }
})
router.patch('/whatsapp/agents/:id', async (req, res) => {
  try {
    const db = req.app.locals.db
    const row = await agentBody(req.body || {})
    await db('whatsapp_agents').where('id', req.params.id).update({ ...row, updated_at: now() })
    res.json(agentRow(await db('whatsapp_agents').where('id', req.params.id).first()))
  } catch (e) { fail(res, e) }
})
router.delete('/whatsapp/agents/:id', async (req, res) => {
  await req.app.locals.db('whatsapp_agents').where('id', req.params.id).update({ active: 0, updated_at: now() })
  res.json({ ok: true })
})

// A profile's CV to the chosen agents (none chosen → every agent).
router.get('/profiles/:id/whatsapp', async (req, res) => { try { res.json(await sendsOf(req.app.locals.db, req.params.id)) } catch (e) { fail(res, e) } })
router.post('/profiles/:id/whatsapp/send', async (req, res) => {
  try { res.json({ results: await sendCV(req.app.locals.db, Number(req.params.id), req.body?.agent_ids || [], req.user?.username || '') }) }
  catch (e) { fail(res, e) }
})
router.post('/profiles/:id/whatsapp/close', async (req, res) => { try { await onChosen(req.app.locals.db, Number(req.params.id)); res.json(await sendsOf(req.app.locals.db, req.params.id)) } catch (e) { fail(res, e) } })

export default router
