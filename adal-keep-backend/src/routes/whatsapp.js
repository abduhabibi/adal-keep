/**
 * /api/whatsapp — each person's WhatsApp (Settings → WhatsApp), their agents,
 * and the CVs they send (profile page, CVs → WhatsApp). Whose WhatsApp: ?u=
 * (the employee chosen on that PC or phone — also through the phone's online
 * copy, which passes no headers).
 */
import express from 'express'
import { lastNumber, keyOf, stateOf, allStates, connect, openWeb, logout, listChats, chatForNumber, agentRow, agentsOf, sendCV, sendMany, bulk, notifyMany, notices, sendsOf, onChosen, available, agentLimit, roomForAgent } from '../services/whatsapp.js'

const router = express.Router()
// Sending CVs on WhatsApp: only the admin employee (signed in as the admin).
router.use((req, res, next) => {
  if (req.method !== 'POST' || !/^\/(whatsapp\/bulk|profiles\/\d+\/whatsapp\/send)$/.test(req.path)) return next()
  if (req.auth?.role === 'admin') return next()
  res.status(403).json({ error: 'Only the admin employee sends CVs on WhatsApp: sign in as the admin (Employees).', admin_only: true })
})
// WhatsApp is in the Standard plan (plans.js): connecting and sending need it; looking does not.
router.use(async (req, res, next) => {
  if (req.method !== 'POST' || !/^\/(whatsapp\/(connect|open-web|bulk|notify)|profiles\/\d+\/whatsapp\/send)/.test(req.path)) return next()
  const { requireFeature } = await import('../services/plans.js')
  requireFeature('whatsapp')(req, res, next)
})
const fail = (res, e) => res.status(400).json({ error: e.message })
const now = () => new Date().toISOString()
const who = (req) => keyOf(req.query.u ?? req.body?.u)
const by = (req) => { try { return decodeURIComponent(req.get('x-adal-who') || '') } catch { return '' } }

router.get('/whatsapp', async (req, res) => res.json({ agent_limit: await agentLimit(req.app.locals.db), ...stateOf(who(req)), key: who(req), last_number: lastNumber(who(req)), others: allStates().filter(s => s.key !== who(req) && s.status === 'ready') }))
router.post('/whatsapp/open-web', async (req, res) => { try { res.json(await openWeb(req.app.locals.db, who(req))) } catch (e) { fail(res, e) } })
router.post('/whatsapp/connect', async (req, res) => { try { res.json(await connect(req.app.locals.db, who(req), { phone: req.body?.phone })) } catch (e) { fail(res, e) } })
router.post('/whatsapp/logout', async (req, res) => { try { await logout(who(req)); res.json(stateOf(who(req))) } catch (e) { fail(res, e) } })
router.get('/whatsapp/chats', async (req, res) => { try { res.json(await listChats(who(req))) } catch (e) { fail(res, e) } })

router.get('/whatsapp/agents', async (req, res) => {
  const db = req.app.locals.db
  const agents = (await agentsOf(db, who(req)).orderBy('name')).map(agentRow)
  const counts = await db('whatsapp_sends').select('agent_id', 'status').count('* as n').groupBy('agent_id', 'status')
  for (const a of agents) a.counts = Object.fromEntries(counts.filter(c => c.agent_id === a.id).map(c => [c.status, Number(c.n)]))
  res.json(agents)
})

async function agentBody(req) {
  const b = req.body || {}
  const row = {}
  if (b.name !== undefined) row.name = String(b.name).trim().slice(0, 120)
  if (b.chat_id) row.chat_id = String(b.chat_id)
  else if (b.number) row.chat_id = await chatForNumber(who(req), b.number)
  if (b.template_ids !== undefined) row.template_ids = JSON.stringify((b.template_ids || []).map(Number).filter(Boolean))
  if (b.musaned_office !== undefined) row.musaned_office = String(b.musaned_office || '').trim().slice(0, 200)
  if (b.active !== undefined) row.active = b.active ? 1 : 0
  return row
}
const mine = (req) => agentsOf(req.app.locals.db, who(req)).andWhere('id', req.params.id)

router.post('/whatsapp/agents', async (req, res) => {
  try {
    const db = req.app.locals.db
    const row = await agentBody(req)
    if (!row.name) throw new Error('Type the agent\'s name')
    if (!row.chat_id) throw new Error('Pick the agent\'s chat or type the number')
    await roomForAgent(db)
    const [id] = await db('whatsapp_agents').insert({ template_ids: '[]', active: 1, ...row, user_key: who(req), created_at: now(), updated_at: now() })
    res.json(agentRow(await db('whatsapp_agents').where('id', id).first()))
  } catch (e) { fail(res, e) }
})
router.patch('/whatsapp/agents/:id', async (req, res) => {
  try {
    if (!(await mine(req).first())) throw new Error('Not one of your agents')
    await mine(req).update({ ...(await agentBody(req)), updated_at: now() })
    res.json(agentRow(await mine(req).first()))
  } catch (e) { fail(res, e) }
})
router.delete('/whatsapp/agents/:id', async (req, res) => {
  await mine(req).update({ active: 0, updated_at: now() })
  res.json({ ok: true })
})

// One profile's CV to the chosen agents (none chosen → all of mine).
router.get('/profiles/:id/whatsapp', async (req, res) => { try { res.json(await sendsOf(req.app.locals.db, req.params.id)) } catch (e) { fail(res, e) } })
router.post('/profiles/:id/whatsapp/send', async (req, res) => {
  try { res.json({ results: await sendCV(req.app.locals.db, who(req), Number(req.params.id), req.body?.agent_ids || [], by(req)) }) }
  catch (e) { fail(res, e) }
})
router.post('/profiles/:id/whatsapp/close', async (req, res) => { try { await onChosen(req.app.locals.db, Number(req.params.id)); res.json(await sendsOf(req.app.locals.db, req.params.id)) } catch (e) { fail(res, e) } })

// CVs → WhatsApp: the ones not chosen yet, and many at once.
router.get('/whatsapp/available', async (req, res) => { try { res.json(await available(req.app.locals.db, who(req))) } catch (e) { fail(res, e) } })
router.get('/whatsapp/bulk', (req, res) => res.json(bulk[who(req)] || { running: false }))
router.post('/whatsapp/bulk', (req, res) => {
  try {
    const ids = (req.body?.profile_ids || []).map(Number).filter(Boolean)
    if (!ids.length) throw new Error('Choose the profiles to send')
    res.json(sendMany(req.app.locals.db, who(req), ids, req.body?.agent_ids || [], by(req)))
  } catch (e) { fail(res, e) }
})

// A message (text and/or a voice note) to each picked profile — her phone or her broker's.
router.get('/whatsapp/notify', (req, res) => res.json(notices[who(req)] || { running: false }))
router.post('/whatsapp/notify', (req, res) => {
  try {
    const ids = (req.body?.profile_ids || []).map(Number).filter(Boolean)
    if (!ids.length) throw new Error('Choose the profiles to message')
    const audio = req.body?.audio?.data ? { data: String(req.body.audio.data), mime: String(req.body.audio.mime || '') } : null
    res.json(notifyMany(req.app.locals.db, who(req), { profileIds: ids, to: ['broker', 'her'].includes(req.body?.to) ? req.body.to : 'agent', text: String(req.body?.text || ''), audio }, by(req)))
  } catch (e) { fail(res, e) }
})

export default router
