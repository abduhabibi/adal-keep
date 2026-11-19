/**
 * automationHealth.js — Settings → Health: for each portal robot and each
 * background job, when it last worked, when it last failed and why, and a
 * green / amber / red dot. Read-only: made from what is already stored (the
 * runs in automation_queue, WhatsApp's sends and connection, the backup's
 * state file, the online copy's status). It starts nothing.
 *
 *   GET /api/system/automation-health
 */
import { plainReason } from './runOutcome.js'

const HOUR = 3600_000, DAY = 24 * HOUR

/** Which portal a run belongs to (by its workflow id). */
export function portalOf(workflowId) {
  const w = String(workflowId || '')
  if (w.startsWith('musaned_')) return 'musaned'
  if (w.startsWith('mofa_')) return 'enjaz'
  if (w.startsWith('lmis') || ['police_certificate', 'contract_import_labour', 'delete_labour'].includes(w)) return 'lmis'
  if (w.startsWith('tasheer_')) return 'tasheer'
  if (w.startsWith('wafid_')) return 'wafid'
  return null
}

export const ITEMS = [
  ['musaned', 'Musaned'], ['enjaz', 'Enjaz'], ['lmis', 'LMIS'], ['tasheer', 'Tasheer'], ['wafid', 'Wafid'],
  ['whatsapp', 'WhatsApp'], ['backup', 'Telegram backup'], ['online', 'Online copy'],
]

const t = (x) => { const n = x ? new Date(x).getTime() : NaN; return Number.isFinite(n) ? n : 0 }
const iso = (n) => n ? new Date(n).toISOString() : null
const short = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'failed'

/**
 * The dot. Green: the newest thing that happened worked. Amber: the newest
 * failed but it worked not long ago (`okFor`), or it has not worked for a
 * while (`staleAfter`). Red: it keeps failing, or a job that should run by
 * itself has not worked for twice that long. Grey: nothing yet / turned off.
 */
export function dotOf({ ok, fail, now = Date.now(), okFor = 3 * DAY, staleAfter = null }) {
  if (!ok && !fail) return 'grey'
  if (fail > ok) return ok && now - ok < okFor ? 'amber' : 'red'
  if (staleAfter && now - ok > 2 * staleAfter) return 'red'
  if (staleAfter && now - ok > staleAfter) return 'amber'
  return 'green'
}

/** Portal robots from their runs (newest first or not: any order). */
export function portalHealth(runs = [], now = Date.now()) {
  const by = {}
  for (const r of runs) {
    const key = portalOf(r.workflow_id)
    if (!key || !['done', 'failed'].includes(r.status)) continue
    const at = t(r.finished_at || r.updated_at)
    const b = by[key] ||= { ok: 0, fail: 0, why: null, running: 0 }
    if (r.status === 'done' && at > b.ok) b.ok = at
    if (r.status === 'failed' && at > b.fail) { b.fail = at; b.why = plainReason(r.pause_reason) }
  }
  for (const r of runs) { const key = portalOf(r.workflow_id); if (key && r.status === 'running') (by[key] ||= { ok: 0, fail: 0, why: null, running: 0 }).running++ }
  return Object.fromEntries(Object.entries(by).map(([k, b]) => [k, {
    last_ok: iso(b.ok), last_fail: iso(b.fail), why: b.fail ? b.why : null, running: b.running,
    dot: dotOf({ ok: b.ok, fail: b.fail, now }),
  }]))
}

/** The whole board, from what each part already keeps. */
export function healthBoard({ runs = [], wa = {}, backup = {}, cloud = {}, now = Date.now() } = {}) {
  const items = portalHealth(runs, now)

  // WhatsApp: its sends, and whether it is connected now.
  {
    const ok = t(wa.last_sent), fail = t(wa.last_failed_at)
    let dot = dotOf({ ok, fail, now })
    let note = null
    if (wa.used && wa.status !== 'ready') { dot = 'red'; note = wa.error ? short(wa.error) : 'not connected' }
    else if (wa.status === 'ready' && dot === 'grey') dot = 'green'
    items.whatsapp = { last_ok: iso(ok), last_fail: iso(fail), why: fail ? short(wa.last_failed_why) : null, note, dot }
  }

  // The Telegram backup: once a day by itself.
  {
    const ok = t(backup.last_ok), fail = t(backup.last_fail_at || (backup.last_error ? backup.last_error_at : null))
    const why = backup.last_fail || backup.last_error
    let dot = dotOf({ ok, fail, now, okFor: 2 * DAY, staleAfter: 2 * DAY })
    let note = null
    if (backup.enabled === false) { dot = 'grey'; note = 'turned off' }
    else if (backup.verify && backup.verify.ok === false && dot === 'green') { dot = 'amber'; note = `did not read back: ${short(backup.verify.why)}` }
    items.backup = { last_ok: iso(ok), last_fail: iso(fail), why: fail ? short(why) : null, note, dot }
  }

  // The online copy: every minute while it is on.
  {
    const ok = t(cloud.last), fail = t(cloud.lastFailAt)
    let dot = dotOf({ ok, fail, now, okFor: HOUR, staleAfter: 30 * 60_000 })
    let note = null
    if (!cloud.on) { dot = 'grey'; note = 'not turned on' }
    items.online = { last_ok: iso(ok), last_fail: iso(fail), why: fail ? short(cloud.lastFail) : null, note, dot }
  }

  return {
    at: iso(now),
    items: ITEMS.map(([key, name]) => ({ key, name, last_ok: null, last_fail: null, why: null, note: null, running: 0, dot: 'grey', ...(items[key] || {}) })),
  }
}

/** Gathers the stored state and builds the board. */
export async function automationHealth(db) {
  const since = new Date(Date.now() - 60 * DAY).toISOString()
  const runs = await db('automation_queue').select('workflow_id', 'status', 'pause_reason', 'finished_at', 'updated_at')
    .whereIn('status', ['done', 'failed', 'running']).where(q => q.where('updated_at', '>=', since).orWhere('status', 'running'))
    .orderBy('id', 'desc').limit(3000).catch(() => [])

  const wa = {}
  try {
    const w = await import('./whatsapp.js')
    const st = w.stateOf(w.keyOf())
    wa.status = st.status; wa.error = st.error
    wa.used = st.status !== 'off' || w.allStates().length > 0
    const sent = await db('whatsapp_sends').whereNot('status', 'failed').max('sent_at as at').first().catch(() => null)
    const failed = await db('whatsapp_sends').where('status', 'failed').orderBy('id', 'desc').first('sent_at', 'error').catch(() => null)
    wa.last_sent = sent?.at || null
    wa.last_failed_at = failed?.sent_at || null
    wa.last_failed_why = failed?.error || null
  } catch {}

  let backup = {}
  try { backup = (await import('./telegramBackup.js')).getConfig() } catch {}
  let cloud = {}
  try { const c = await import('./cloudSync.js'); cloud = { ...c.cloudStatus, on: await c.cloudOn(db).catch(() => c.cloudStatus.on) } } catch {}

  return healthBoard({ runs, wa, backup, cloud })
}
