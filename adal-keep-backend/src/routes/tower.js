/**
 * Crash reports for Adal (services/tower.js → Admin → Fleet): the pages'
 * error boundaries and the Go programs (launcher, Companion) send theirs here.
 * Only counted, grouped by message; nothing personal (numbers are hidden).
 */
import { Router } from 'express'
import { noteCrash, towerStatus } from '../services/tower.js'

const router = Router()
const SOURCES = /^(frontend|launcher|companion|backend|phone|agent)$/

router.post('/tower/crash', (req, res) => {
  const b = req.body || {}
  const source = SOURCES.test(String(b.source || '')) ? b.source : 'other'
  const g = noteCrash({ source, message: String(b.message || '').slice(0, 1000), where: String(b.where || '').slice(0, 200), stack: String(b.stack || '').slice(0, 2000), version: b.version ? String(b.version) : null })
  res.json({ ok: !!g, count: g?.count || 0 })
})

router.get('/tower/status', (req, res) => res.json(towerStatus()))

export default router
