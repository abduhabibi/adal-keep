/**
 * Starts Adal Keep (main.js) so that a bad update cannot stop an agency:
 * when a just-installed version fails to start 3 times, the version before it
 * is put back and started instead (safeStart.js). Kept small on purpose.
 */
import path from 'path'
import { fileURLToPath } from 'url'
import { noteStart, startedWell, shouldRollBack, rollBack } from './safeStart.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const info = noteStart(HERE)
// A version that has not run 2 minutes yet, started again: said, so a going back later has its story.
if (info.guarded && info.starts > 1) console.warn(`[start] version ${String(info.sha).slice(0, 7)}: start ${info.starts} without 2 good minutes (at 3 it goes back to the version before)`)
const prev = shouldRollBack(HERE, info)
if (prev) {
  try {
    const r = rollBack(HERE, prev, `version ${String(info.sha).slice(0, 7)} failed to start ${info.starts} times`)
    console.error(`[start] version ${String(r.from).slice(0, 7)} did not start — went back to ${String(r.to).slice(0, 7)}`)
  } catch (e) { console.error('[start] going back to the previous version failed:', e.message) }
  process.exit(1) // the launcher starts the version put back
}
// Closed on purpose (X, an update) or running for 2 minutes: this version is good.
process.on('exit', (code) => { if (code === 0) startedWell(HERE) })
setTimeout(() => startedWell(HERE), 120_000).unref()

try {
  await import('./main.js')
  // A server that freezes is ended (and started again by the launcher), never left hanging.
  if (info.guarded) import('./src/services/watchdog.js').then(w => w.startWatchdog(path.join(HERE, 'data'))).catch(() => {})
} catch (e) {
  console.error('[start] Adal Keep could not start:', e?.stack || e)
  process.exit(1)
}
