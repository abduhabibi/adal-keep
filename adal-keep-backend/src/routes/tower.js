/**
 * Crash reports for Adal (services/tower.js → Admin → Fleet): the pages'
 * error boundaries and the Go programs (launcher, Companion) send theirs here.
 * Only counted, grouped by message; nothing personal (numbers are hidden).
 */
import { Router } from 'express'
import { noteCrash, towerStatus, createTicket, ticketList } from '../services/tower.js'

const router = Router()
const SOURCES = /^(frontend|launcher|companion|backend|phone|agent)$/

router.post('/tower/crash', (req, res) => {
  const b = req.body || {}
  const source = SOURCES.test(String(b.source || '')) ? b.source : 'other'
  const g = noteCrash({ source, message: String(b.message || '').slice(0, 1000), where: String(b.where || '').slice(0, 200), stack: String(b.stack || '').slice(0, 2000), version: b.version ? String(b.version) : null })
  res.json({ ok: !!g, count: g?.count || 0 })
})

router.get('/tower/status', (req, res) => { const s = towerStatus(); res.json(req.query.short ? { on: s.on } : s) })

// The Help button: a note (+ a picture of the screen) → a ticket in Admin with this PC's logs.
router.post('/tower/ticket', async (req, res) => {
  try {
    const db = req.app.locals.db
    const w = await import('../services/staffRoles.js').then(S => S.whoIsAsking(db, req)).catch(() => null)
    let who = w?.user ? (w.user.full_name || w.user.name || w.user.username || null) : null
    if (!who) who = await import('../services/activeEmployee.js').then(a => a.getActiveEmployee(db)).then(e => e?.name || null).catch(() => null)
    if (who && w?.kind === 'phone') who = `${who} (phone)`
    res.json(await createTicket(db, { text: req.body?.text, image: req.body?.image || null, who, page: req.body?.page }))
  } catch (e) { res.status(e.code || 500).json({ error: e.message }) }
})
router.get('/tower/tickets', (req, res) => res.json({ tickets: ticketList().slice(0, 20) }))

export default router
