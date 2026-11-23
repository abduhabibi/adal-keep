/**
 * runPriority.js — the line of runs waiting to start, and the person's say in it.
 *
 * A waiting run is a row of automation_queue with status 'pending' (in the line) or
 * 'paused' (taken out of it). The worker starts the highest `priority` first, the
 * oldest among equals (worker.js claimNextJob). Here a person moves a run up or
 * down, or makes it run next; pause and cancel are the routes that already exist.
 * Rows are copied to every PC, so the order is the same everywhere.
 */
import { readyJobsQuery } from './worker.js'
import { workflowName } from './runOutcome.js'

/** The line as the worker sees it: highest priority first, then oldest. */
const inLine = (db) => readyJobsQuery(db).orderBy([{ column: 'priority', order: 'desc' }, { column: 'id', order: 'asc' }])

export async function hasPriority(db) {
  return db.schema.hasColumn('automation_queue', 'priority')
}

/** Everything waiting: the line first (in start order), then the paused ones. */
export async function waiting(db) {
  if (!(await hasPriority(db))) return []
  const rows = await db('automation_queue as q')
    .leftJoin('profiles as p', 'p.id', 'q.profile_id')
    .whereIn('q.status', ['pending', 'paused'])
    .select('q.id', 'q.profile_id', 'q.workflow_id', 'q.status', 'q.pause_reason', 'q.priority', 'q.updated_at', 'p.full_name as profile_name')
  const line = (await inLine(db).select('id')).map(r => r.id)
  const rank = new Map(line.map((id, i) => [id, i + 1]))
  return rows.map(r => ({
    id: r.id, profile_id: r.profile_id, profile_name: r.profile_name || '', workflow_id: r.workflow_id,
    workflow: workflowName(r.workflow_id), status: r.status, reason: r.pause_reason || '',
    priority: Number(r.priority || 0), position: rank.get(r.id) || null,
  })).sort((a, b) => (a.position ?? 1e9) - (b.position ?? 1e9) || a.id - b.id)
}

/** Move run `id` in the line: 'up' / 'down' one place, 'next' to the front. Returns the new line. */
export async function move(db, id, how) {
  id = Number(id)
  const row = await db('automation_queue').where('id', id).first()
  if (!row) throw Object.assign(new Error('Run not found'), { status: 404 })
  if (row.status !== 'pending') throw Object.assign(new Error(row.status === 'running' ? `Run #${id} is already working.` : `Run #${id} is ${row.status} — it is not in the line.`), { status: 409 })
  // Only runs that can start now are in the line; a run waiting out its wait time keeps its place by priority too.
  const line = (await db('automation_queue').where('status', 'pending').orderBy([{ column: 'priority', order: 'desc' }, { column: 'id', order: 'asc' }]).select('id')).map(r => r.id)
  const i = line.indexOf(id)
  if (how === 'next') { line.splice(i, 1); line.unshift(id) }
  else if (how === 'up') { if (i > 0) [line[i - 1], line[i]] = [line[i], line[i - 1]] }
  else if (how === 'down') { if (i < line.length - 1) [line[i + 1], line[i]] = [line[i], line[i + 1]] }
  else throw Object.assign(new Error('up, down or next'), { status: 400 })
  // Priorities are rewritten as the new order (the first has the highest); only changed rows are touched,
  // so they are the only ones copied to the other PCs.
  const cur = new Map((await db('automation_queue').whereIn('id', line).select('id', 'priority')).map(r => [r.id, Number(r.priority || 0)]))
  const now = new Date().toISOString()
  for (let k = 0; k < line.length; k++) {
    const p = line.length - k
    if (cur.get(line[k]) !== p) await db('automation_queue').where('id', line[k]).andWhere('status', 'pending').update({ priority: p, updated_at: now })
  }
  return line
}
