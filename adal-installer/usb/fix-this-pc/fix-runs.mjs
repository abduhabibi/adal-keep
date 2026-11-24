// fix-runs.mjs — run by fix-this-pc.ps1 with Adal Keep's own Node: every robot run that is
// waiting, working or paused is marked cancelled (with a note), in each database given.
// Nothing else in the database is changed; nothing is deleted.
//   node fix-runs.mjs <backend folder> <data.sqlite> [<data.sqlite> …]
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'
const [backend, ...dbs] = process.argv.slice(2)
const require = createRequire(path.join(backend, 'package.json'))
const knex = require('knex')
const NOTE = 'Stopped by "Fix this PC" (USB)'
let total = 0
for (const file of dbs) {
  if (!fs.existsSync(file)) continue
  const db = knex({ client: 'sqlite3', connection: { filename: file }, useNullAsDefault: true, pool: { min: 1, max: 1, afterCreate: (c, done) => c.run('PRAGMA busy_timeout = 15000', done) } })
  try {
    const now = new Date().toISOString()
    let n = 0
    if (await db.schema.hasTable('automation_queue')) {
      const cols = await db('automation_queue').columnInfo()
      const rows = await db('automation_queue').whereIn('status', ['pending', 'running', 'paused', 'waiting', 'queued']).select('id', 'log')
      for (const r of rows) {
        const patch = { status: 'cancelled' }
        if (cols.pause_reason) patch.pause_reason = NOTE
        if (cols.finished_at) patch.finished_at = now
        if (cols.updated_at) patch.updated_at = now
        if (cols.log) { let log = []; try { log = JSON.parse(r.log || '[]') } catch {} ; if (Array.isArray(log)) { log.push({ ts: now, level: 'warn', msg: NOTE }); patch.log = JSON.stringify(log) } }
        await db('automation_queue').where('id', r.id).update(patch)
        n++
      }
    }
    if (await db.schema.hasTable('run_history')) {
      const cols = await db('run_history').columnInfo()
      if (cols.outcome) await db('run_history').whereIn('outcome', ['running', 'paused']).update({ outcome: 'cancelled', ...(cols.ended_at ? { ended_at: now } : {}), ...(cols.reason ? { reason: NOTE } : {}) })
    }
    console.log(`RUNS ${file} ${n}`)
    total += n
  } catch (e) { console.log(`RUNS-ERROR ${file} ${e.message}`) } finally { await db.destroy() }
}
console.log(`RUNS-TOTAL ${total}`)
