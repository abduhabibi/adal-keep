/**
 * lastEnd.mjs — how the last Adal Robots ended, said by the next one (2026-11-27, Main's robots.log: 20 starts in a
 * few days with no line before them — no error, no "stopping": ended from outside). A note in data/robots-alive.json,
 * written every 30 s (the time, free memory, runs working) and on a clean stop; the next start reads it and says one
 * line. Off: ADAL_ROBOTS_LAST_END=0.
 */
import fs from 'fs'
import os from 'os'
import path from 'path'

export const lastEndOn = (env = process.env) => env.ADAL_ROBOTS_LAST_END !== '0'
const hm = (t) => new Date(t).toTimeString().slice(0, 8)

/** The line for the last one's end ('' when it stopped cleanly, or there is no note). Pure. */
export function lastEndLine(note, { pid = process.pid, now = Date.now() } = {}) {
  if (!note || !note.pid || note.pid === pid || note.stopped) return ''
  const gap = Math.round((now - note.at) / 60000)
  return `the last Adal Robots (pid ${note.pid}, up ${Math.round((note.at - note.started) / 60000)} min) ended without stopping — ` +
    `last seen ${hm(note.at)} with ${note.freeMB} MB free and ${note.running} run(s) working, ${gap} min before this start` +
    (gap > 2 ? ' (Adal Keep itself was stopped meanwhile: Quit, an install or the PC)' : ' (ended from outside or out of memory)')
}

/** Says how the last one ended, then keeps the note. → { stopped(why) } for a clean stop. */
export function watchLastEnd(dataDir, { say, running = () => 0, everyMs = 30000 } = {}) {
  if (!lastEndOn()) return { stopped() {} }
  const file = path.join(dataDir, 'robots-alive.json'), started = Date.now()
  try { const line = lastEndLine(JSON.parse(fs.readFileSync(file, 'utf8'))); if (line) say(line) } catch {}
  const write = (extra = {}) => { try { fs.writeFileSync(file, JSON.stringify({ pid: process.pid, started, at: Date.now(), freeMB: Math.round(os.freemem() / 1048576), running: running(), ...extra })) } catch {} }
  write()
  const t = setInterval(write, everyMs); t.unref?.()
  return { stopped(why) { clearInterval(t); write({ stopped: why }) } }
}
