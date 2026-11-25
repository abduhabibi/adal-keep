/** Adal Keep's window on this PC; closing it keeps Adal Keep working, Quit stops it (services/appLife.js). */
import express from 'express'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'
import { isLocal } from '../services/networkGate.js'
import { windowOpened, windowsOpen, busyNow, endEverything } from '../services/appLife.js'
import { onShown } from '../services/changes.js'

const router = express.Router()

// One stream per window. It also says, every few seconds, whether something is working.
router.get('/app/alive', async (req, res) => {
  if (!isLocal(req)) return res.status(204).end()
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
  res.flushHeaders()
  const gone = windowOpened(res)
  const tell = async () => { res.write(`data: ${JSON.stringify({ ...(await busyNow()), windows: windowsOpen() })}\n\n`) }
  // ?all=1: the window's other two streams (/changes, /app/clips) come on this one too, as
  // named events (asked on 2026-11-23): a browser opens only 6 lines to one PC, and three
  // streams per window left too few for the pages (and the live robot view) when two were open.
  const offs = []
  if (req.query.all === '1') {
    offs.push(onShown((c) => res.write(`event: changes\ndata: ${JSON.stringify(c)}\n\n`)))
    const { listen } = await import('../services/screenClip.js')
    offs.push(listen({ write: (s) => res.write(`event: clips\n${s}`) }))
  }
  await tell()
  const t = setInterval(() => tell().catch(() => {}), 5000)
  req.on('close', () => { clearInterval(t); gone(); for (const off of offs) off() })
})

// Every window (this PC and the employees' PCs): which tables changed, as they change.
router.get('/changes', async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  res.write(': hello\n\n')
  const off = onShown((c) => res.write(`data: ${JSON.stringify(c)}\n\n`))
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  let offClips = () => {}, gone = false
  req.on('close', () => { gone = true; clearInterval(ping); off(); offClips() })
  // Another PC's window: the pictures its own double C crops (a named event; older pages skip it).
  if (!isLocal(req)) try { const c = await import('../services/clipRelay.js'); if (!gone) offClips = c.listenPC(req, res) } catch {}
})

// Double "C" in Adal Keep: Windows' own screen crop (as Win+Shift+S) on this
// PC; the cropped picture comes back to the page (it goes into the tray).
router.post('/app/screen-clip', async (req, res) => {
  if (!isLocal(req) || req.headers['x-adal-cloud'] || process.platform !== 'win32') return res.status(403).json({ error: 'The double C is not running on this computer: press Win+Shift+S, then Ctrl+V in Adal Keep.' })
  const out = path.join(os.tmpdir(), `adal-clip-${Date.now()}.png`)
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'screen-clip.ps1')
  execFile('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script, '-Out', out, '-WaitSeconds', '120'],
    { windowsHide: true, timeout: 130000 }, (e, stdout) => {
      if (String(stdout).trim() !== 'ok' || !fs.existsSync(out)) return res.status(204).end()   // nothing cropped
      res.setHeader('Content-Type', 'image/png')
      res.send(fs.readFileSync(out))
      fs.unlink(out, () => {})
    })
})

// The double-C watcher (bin/adal-clip.exe) sends its picture, or how the crop
// stands; every open Adal Keep page of this PC gets it in its tray (services/screenClip.js).
router.post('/app/clip', express.raw({ type: 'image/png', limit: '60mb' }), async (req, res) => {
  if (!isLocal(req)) return (await import('../services/clipRelay.js')).fromPC(req, res)   // a Companion's own watcher
  const { took } = await import('../services/screenClip.js')
  took(Buffer.isBuffer(req.body) ? req.body : null, req.query.state ? String(req.query.state) : '')
  res.json({ ok: true })
})
router.get('/app/clips', async (req, res) => {
  if (!isLocal(req)) return res.status(204).end()
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' })
  res.flushHeaders()
  const { listen } = await import('../services/screenClip.js')
  const off = listen(res)
  const ping = setInterval(() => res.write(': ping\n\n'), 25000)
  req.on('close', () => { clearInterval(ping); off() })
})
router.get('/app/clips/:id', async (req, res) => {
  const c = isLocal(req) ? (await import('../services/screenClip.js')).clipOf(req.params.id) : (await import('../services/clipRelay.js')).clipFor(req, req.params.id)
  if (!c) return res.status(404).end()
  res.type('image/png').send(c.png)
})

// "Quit Adal Keep" (after a Yes in the page): stops everything on this PC.
router.post('/app/quit', (req, res) => {
  if (!isLocal(req) || req.headers['x-adal-cloud']) return res.status(403).json({ error: 'Only on the main PC itself' })
  res.json({ ok: true })
  endEverything('Quit was pressed')
})

export default router
