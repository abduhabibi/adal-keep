/**
 * taskGate.js — no task that is not needed (the owner, 2026-11-27). Before a task is made by itself (the scanner, the
 * first stage, the agency manager, Wafid's checks): not one already in line for that girl and step, not a step already
 * done for her (but the ones made again on purpose: checks, status reads, fetches), and the girl has what the step
 * needs (her passport number). Otherwise it is not made, and one line says why: in the log and on the Robots page
 * ("Not made", data/task-skips.json — Adal Robots and Adal Keep both read it). A person's Start is not gated here (it
 * says "already queued" itself). Off: ADAL_TASK_GATE=0. Any error: the task is made, as before.
 */
import fs from 'fs'
import path from 'path'

export const taskGateOn = (env = process.env) => env.ADAL_TASK_GATE !== '0'
const OPEN = ['pending', 'running', 'paused']
// Made again on purpose (a look now and then, a fetch until it comes): "done before" does not stop them.
const AGAIN = /check|status|fetch|slip|result|scan|import|sync/i
// The steps that work with her passport on a site.
const NEEDS_PASSPORT = /^(musaned_add|wafid_book|tasheer|insurance_certificate|mofa|visa)/i
const FILE = () => path.resolve(process.env.ADAL_ROBOTS_DATA || path.join(process.cwd(), 'data'), 'task-skips.json')

/** Why this task is not needed ('' = make it). Pure. open/done: rows of hers for that step; profile: her row. */
export function notNeeded({ workflowId, profile, open = [], done = [] }) {
  if (open.length) return `already in line for her (#${open[0].id}, ${open[0].status})`
  if (done.length && !AGAIN.test(workflowId)) return `done already for her (#${done[0].id})`
  if (!profile) return 'her profile is not there'
  if (NEEDS_PASSPORT.test(workflowId) && !String(profile.passport_number || '').trim()) return 'no passport number on her profile'
  return ''
}

/** → { ok: true } or { ok: false, why } (said once in the log and kept for the Robots page). */
export async function taskNeeded(db, { profileId, workflowId, by = 'by itself', log = (m) => console.log(m) }) {
  if (!taskGateOn()) return { ok: true }
  try {
    const rows = await db('automation_queue').where({ profile_id: profileId, workflow_id: workflowId }).whereIn('status', [...OPEN, 'done']).orderBy('id', 'desc').select('id', 'status').limit(20)
    const profile = await db('profiles').where('id', profileId).first('id', 'full_name', 'passport_number')
    const why = notNeeded({ workflowId, profile, open: rows.filter(r => OPEN.includes(r.status)), done: rows.filter(r => r.status === 'done') })
    if (!why) return { ok: true }
    keepSkip({ at: new Date().toISOString(), workflow: workflowId, profile_id: profileId, name: profile?.full_name || '', why, by })
    log(`[task-gate] ${workflowId} for ${profile?.full_name || `#${profileId}`} not made: ${why}`)
    return { ok: false, why }
  } catch { return { ok: true } }
}

const said = new Map()   // the same skip is kept once an hour (the scanner looks every 2 minutes)
function keepSkip(k) {
  try {
    const key = `${k.workflow}:${k.profile_id}:${k.why}`
    if (Date.now() - (said.get(key) || 0) < 3600e3) return
    said.set(key, Date.now())
    const all = [k, ...lastSkipped().filter(x => `${x.workflow}:${x.profile_id}:${x.why}` !== key)].slice(0, 50)
    fs.mkdirSync(path.dirname(FILE()), { recursive: true })
    fs.writeFileSync(FILE() + '.new', JSON.stringify(all)); fs.renameSync(FILE() + '.new', FILE())
  } catch {}
}
/** The last tasks not made (newest first), from this PC's both programs. */
export function lastSkipped() { try { const a = JSON.parse(fs.readFileSync(FILE(), 'utf8')); return Array.isArray(a) ? a : [] } catch { return [] } }
