/**
 * watchdog.js — a server that hangs is restarted, not left frozen.
 *
 * The launcher restarts a server that stops, but one that freezes (stuck in
 * a loop, its event loop blocked) keeps the port and answers nothing: every
 * page spins. A small thread watches a heartbeat the server writes every
 * 5 s; when none came for FREEZE_MS, the thread notes it in
 * data/last-freeze.json and ends the process, and the launcher starts a fresh one.
 * Admin sees the note with the PC's health (diag.js).
 */
import { Worker } from 'worker_threads'
import path from 'path'

export const FREEZE_MS = 180_000

const WATCHER = `
const { workerData } = require('worker_threads')
const fs = require('fs')
const beat = new Int32Array(workerData.buf)
let last = Atomics.load(beat, 0), since = Date.now(), tick = Date.now()
setInterval(() => {
  // This thread was paused too (the PC slept): the server gets a fresh start to beat.
  if (Date.now() - tick > workerData.everyMs * 4) since = Date.now()
  tick = Date.now()
  const now = Atomics.load(beat, 0)
  if (now !== last) { last = now; since = Date.now(); return }
  if (Date.now() - since < workerData.freezeMs) return
  try { fs.writeFileSync(workerData.note, JSON.stringify({ at: new Date().toISOString(), seconds: Math.round((Date.now() - since) / 1000) })) } catch {}
  process.kill(workerData.pid, 'SIGKILL')
}, workerData.everyMs)
`

let started = null

/** Starts the watcher; `dataDir` holds last-freeze.json. */
export function startWatchdog(dataDir, { freezeMs = FREEZE_MS, beatMs = 5000 } = {}) {
  if (started) return started
  const buf = new SharedArrayBuffer(4)
  const beat = new Int32Array(buf)
  const t = setInterval(() => Atomics.add(beat, 0, 1), beatMs)
  t.unref?.()
  const w = new Worker(WATCHER, { eval: true, workerData: { buf, freezeMs, pid: process.pid, note: path.join(dataDir, 'last-freeze.json'), everyMs: Math.min(5000, Math.max(100, Math.floor(freezeMs / 3))) } })
  w.unref()
  w.on('error', () => {})
  started = { stop: () => { clearInterval(t); w.terminate() } }
  return started
}
