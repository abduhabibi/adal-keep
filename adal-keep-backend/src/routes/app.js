/** Adal Keep's window on this PC: while one is open Adal Keep lives (services/appLife.js). */
import express from 'express'
import { isLocal } from '../services/networkGate.js'
import { windowOpened, windowsOpen, busyNow, endEverything } from '../services/appLife.js'
import { onChanged } from '../services/changes.js'

const router = express.Router()

// One stream per window. It also says, every few seconds, whether something is working.
router.get('/app/alive', async (req, res) => {
  if (!isLocal(req)) return res.status(204).end()
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  res.flushHeaders()
  const gone = windowOpened(res)
  const tell = async () => { res.write(`data: ${JSON.stringify({ ...(await busyNow()), windows: windowsOpen() })}\n\n`) }
  await tell()
  const t = setInterval(() => tell().catch(() => {}), 5000)
  req.on('close', () => { clearInterval(t); gone() })
})

// Every window (this PC and the employees' PCs): which tables changed, as they change.
router.get('/changes', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.write(': hello\n\n')
  const off = onChanged((c) => res.write(`data: ${JSON.stringify(c)}\n\n`))
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => { clearInterval(ping); off() })
})

// "Quit Adal Keep": the same as closing its last window, at once.
router.post('/app/quit', (req, res) => {
  if (!isLocal(req)) return res.status(403).json({ error: 'Only on the main PC itself' })
  res.json({ ok: true })
  endEverything('Quit was pressed')
})

export default router
