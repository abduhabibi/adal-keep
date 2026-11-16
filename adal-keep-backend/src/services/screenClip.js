/**
 * The double "C" screen crop, anywhere on this PC while Adal Keep runs
 * (asked on 2026-11-16: fast — also on old PCs — and also when the Adal Keep
 * page is not the one in front).
 *
 * bin/adal-clip.exe (source: adal-clip/) watches the keyboard: "C" pressed
 * twice quickly opens Windows' own crop at once and sends the picture here.
 * It starts with this server and ends with it. The pictures go to every open
 * Adal Keep page of this PC (GET /api/app/clips, a stream): into its tray.
 */
import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import { fileURLToPath } from 'url'

// Each version of the watcher has its own name (adal-clip-2.exe, -3 …): an update
// never has to overwrite the running one — Windows refuses that, and the
// whole update stopped ("Access is denied … adal-clip.exe", 2026-11-16).
const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin')
const newestExe = () => {
  try {
    const all = fs.readdirSync(BIN).map(f => [f, /^adal-clip(?:-(\d+))?\.exe$/i.exec(f)]).filter(([, m]) => m)
    all.sort((a, b) => Number(b[1][1] || 0) - Number(a[1][1] || 0))
    return all.length ? path.join(BIN, all[0][0]) : ''
  } catch { return '' }
}
const KEEP_MS = 10 * 60000
const clips = []            // { id, at, png }
const pages = new Set()     // the open pages' streams
let nextId = 1, watcher = null, tries = 0
export const clipState = { running: false }

const send = (m) => { for (const res of pages) { try { res.write(`data: ${JSON.stringify(m)}\n\n`) } catch {} } }

/** A page listens: { hook } at once, then { state } and { clip } as they come. */
export function listen(res) {
  pages.add(res)
  res.write(`data: ${JSON.stringify({ hook: clipState.running })}\n\n`)
  return () => pages.delete(res)
}

/** From the watcher: a picture (PNG bytes), or how the crop stands ('cropping' | 'none'). */
export function took(png, state) {
  if (state) return send({ state })
  if (!png?.length) return
  const now = Date.now()
  while (clips.length && (now - clips[0].at > KEEP_MS || clips.length > 10)) clips.shift()
  const c = { id: nextId++, at: now, png }
  clips.push(c)
  console.log(`[clip] a cropped picture (${Math.round(png.length / 1024)} KB) → the open pages' tray`)
  send({ clip: c.id, at: now })
}
export const clipOf = (id) => clips.find(c => c.id === Number(id)) || null

/** Starts the watcher (Windows; one per PC). It ends with this server. */
export function startClipWatcher(port) {
  const EXE = newestExe()
  if (process.platform !== 'win32' || watcher || !EXE) return
  watcher = spawn(EXE, ['--server', `http://127.0.0.1:${port}`, '--parent', String(process.pid)], { windowsHide: true, stdio: 'ignore' })
  clipState.running = true
  send({ hook: true })
  watcher.on('exit', (code) => {
    watcher = null
    clipState.running = false
    send({ hook: false })
    // Ended by itself (not because another watcher runs): started again, a few times.
    if (code !== 0 && tries++ < 5) setTimeout(() => startClipWatcher(port), 5000 * tries)
  })
  watcher.on('error', (e) => { console.warn('[clip] watcher:', e.message); clipState.running = false })
  console.log('[clip] double C crops the screen anywhere on this PC')
}

/** Before an update: the watcher stops (its file is free), and starts again with the new server. */
export function stopClipWatcher() {
  if (!watcher) return Promise.resolve()
  const w = watcher
  tries = 99   // (not started again by itself now)
  return new Promise(res => { w.once('exit', () => res()); try { w.kill() } catch { res() } setTimeout(res, 3000) })
}
