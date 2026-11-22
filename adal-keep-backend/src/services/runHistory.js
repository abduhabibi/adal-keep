/**
 * runHistory.js — what each robot did, kept for 30 days (asked on 2026-11-22).
 *
 * Every try of a run (and every move from another system) is one row: who
 * started it, the PC and the site, the profile, start, end, how long, how it
 * ended and the step it stopped at; when it did not finish, also a small
 * picture of its tab taken at the stop (JPEG, ≤ 100 KB). The rows are in the
 * main PC's database, so every PC and Companion shows the same list.
 * Nothing here may ever stop a robot: every call is best effort.
 */
import os from 'os'
import { plainReason, workflowName } from './runOutcome.js'

export const KEEP_DAYS = 30
export const SHOT_MAX = 100 * 1024

const SITES = [
  [/^musaned/, 'Musaned'], [/^mofa|^visa/, 'Enjaz'], [/^wafid/, 'Wafid'], [/^insurance/, 'Insurance'], [/^tasheer/, 'Tasheer'],
  [/^(police|lmis|contract_import|delete_labour)/, 'LMIS'], [/^enjazplus/, 'EnjazPlus'], [/^pextran/, 'Pextran'], [/^easyenjaz/, 'EasyEnjaz'],
]
export const siteName = (workflowId) => SITES.find(([re]) => re.test(String(workflowId || '')))?.[1] || ''

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n)
const OUTCOMES = new Set(['done', 'failed', 'cancelled', 'paused', 'stopped'])

/** The step a run stopped at: its last line that is not a result or a stop notice. */
export function stepFromLog(log) {
  let lines = log
  if (typeof log === 'string') { try { lines = JSON.parse(log) } catch { lines = [] } }
  if (!Array.isArray(lines)) return ''
  const msgs = lines.map(l => String(l?.msg || '')).filter(Boolean)
  const step = [...msgs].reverse().find(m => !/^(⛔|⏸|✗|❌|Retry )/.test(m) && !/^▶ Run #/.test(m))
  return clip(step, 240)
}

/** Picture of a tab, small: scaled down and squeezed until it is ≤ SHOT_MAX. */
export async function compress(buf, max = SHOT_MAX) {
  const sharp = (await import('sharp')).default
  let width = 960, quality = 55, out = buf
  for (let i = 0; i < 6; i++) {
    out = await sharp(buf).resize({ width, withoutEnlargement: true }).jpeg({ quality, mozjpeg: true }).toBuffer()
    if (out.length <= max) return out
    width = Math.round(width * 0.8); quality = Math.max(25, quality - 8)
  }
  return out.length <= max ? out : null
}

/** The tab as it is now, small; null when it cannot be had in 6 s. */
export async function takeShot(page) {
  if (!page || page.isClosed?.()) return null
  try {
    const raw = await Promise.race([
      page.screenshot({ type: 'jpeg', quality: 60, captureBeyondViewport: false }),
      new Promise((_, no) => setTimeout(() => no(new Error('no picture')), 6000).unref?.()),
    ])
    return await compress(Buffer.from(raw))
  } catch { return null }
}

export const myPcName = () => `${os.hostname()}`

/** A run (or move) starts: its row, or null when none could be made. */
export async function begin(db, o = {}) {
  try {
    const workflowId = o.workflow_id || ''
    const [id] = await db('run_history').insert({
      run_id: o.run_id ?? null,
      kind: o.kind || 'run',
      workflow_id: workflowId,
      workflow: clip(o.workflow || workflowName(workflowId), 80),
      site: clip(o.site || siteName(workflowId), 40),
      profile_id: o.profile_id ?? null,
      profile_name: clip(o.profile_name, 120),
      account: clip(o.account, 80),
      employee: clip(o.employee, 80),
      pc: clip(o.pc || myPcName(), 80),
      started_at: o.started_at || new Date().toISOString(),
      outcome: 'running',
    })
    return id
  } catch (e) { console.warn('[history] not started:', e.message); return null }
}

/** The row's end: outcome, reason, step, duration and (when it did not finish) the picture. */
export async function finish(db, id, o = {}) {
  if (!id) return
  try {
    const row = await db('run_history').where('id', id).first()
    if (!row) return
    const ended = o.ended_at || new Date().toISOString()
    const outcome = OUTCOMES.has(o.outcome) ? o.outcome : 'done'
    const reason = o.reason ? (outcome === 'failed' ? plainReason(o.reason) : clip(o.reason, 300)) : ''
    let shot = null
    if (o.page && outcome !== 'done') shot = await takeShot(o.page)
    await db('run_history').where('id', id).update({
      ended_at: ended, outcome, reason,
      step: clip(o.step, 240),
      duration_s: Math.max(0, Math.round((Date.parse(ended) - Date.parse(row.started_at)) / 1000)) || 0,
      has_shot: !!shot,
    })
    if (shot) await db('run_history_shots').insert({ history_id: id, jpg: shot, taken_at: ended }).catch(async () => {
      await db('run_history_shots').where('history_id', id).update({ jpg: shot, taken_at: ended })
    })
  } catch (e) { console.warn('[history] not finished:', e.message) }
}

/**
 * A run's end, from its row in automation_queue (what runJob sees when it is
 * over): the latest open history row of that run gets the outcome.
 */
export async function finishRun(db, runId, page = null) {
  try {
    const open = await db('run_history').where({ run_id: runId, outcome: 'running' }).orderBy('id', 'desc').first()
    if (!open) return
    const row = await db('automation_queue').where('id', runId).first()
    const status = row?.status
    const outcome = status === 'running' || status === 'pending' ? (status === 'pending' ? 'failed' : 'stopped') : (status || 'stopped')
    // A run back in the queue (pending) is a try that failed and waits for its retry.
    const reason = outcome === 'failed' || outcome === 'paused' || outcome === 'cancelled' ? row?.pause_reason : ''
    await finish(db, open.id, { outcome, reason: reason || (status === 'pending' ? row?.pause_reason : ''), step: stepFromLog(row?.log), page })
  } catch (e) { console.warn('[history] run end:', e.message) }
}

/** Closes rows that were running when the server stopped (they cannot finish any more). */
export async function closeStale(db) {
  try {
    const now = new Date().toISOString()
    const rows = await db('run_history').where('outcome', 'running').select('id')
    for (const r of rows) await finish(db, r.id, { outcome: 'stopped', reason: 'Adal Keep was closed or restarted while it worked', ended_at: now })
  } catch {}
}

/** Rows (and pictures) older than KEEP_DAYS go. Returns how many rows. */
export async function prune(db, now = Date.now()) {
  try {
    const cut = new Date(now - KEEP_DAYS * 86400_000).toISOString()
    const old = await db('run_history').where('started_at', '<', cut).where('outcome', '!=', 'running').select('id')
    if (!old.length) return 0
    const ids = old.map(r => r.id)
    for (let i = 0; i < ids.length; i += 400) {
      const part = ids.slice(i, i + 400)
      await db('run_history_shots').whereIn('history_id', part).del()
      await db('run_history').whereIn('id', part).del()
    }
    return ids.length
  } catch { return 0 }
}

/** The rows, newest first, narrowed by filters; q looks in the names, the step and the reason. */
export async function list(db, f = {}) {
  const q = db('run_history').orderBy('started_at', 'desc').orderBy('id', 'desc')
  if (f.site) q.where('site', f.site)
  if (f.outcome) q.where('outcome', f.outcome)
  if (f.employee) q.where('employee', f.employee)
  if (f.pc) q.where('pc', f.pc)
  if (f.profile_id) q.where('profile_id', Number(f.profile_id))
  if (f.from) q.where('started_at', '>=', f.from)
  if (f.to) q.where('started_at', '<=', f.to)
  if (f.q) {
    const like = `%${String(f.q).trim().replace(/[%_]/g, m => '\\' + m)}%`
    q.where(w => w.whereRaw(`(coalesce(profile_name,'') || ' ' || coalesce(workflow,'') || ' ' || coalesce(step,'') || ' ' || coalesce(reason,'') || ' ' || coalesce(account,'')) like ? escape '\\'`, [like]))
  }
  const limit = Math.min(500, Math.max(1, Number(f.limit) || 100))
  const rows = await q.limit(limit).offset(Math.max(0, Number(f.offset) || 0))
  return rows.map(r => ({ ...r, has_shot: !!r.has_shot }))
}

/** What each filter can offer: the sites, people and PCs that appear. */
export async function choices(db) {
  const col = async (c) => (await db('run_history').distinct(c).whereNotNull(c).where(c, '!=', '').orderBy(c)).map(r => r[c])
  return { sites: await col('site'), employees: await col('employee'), pcs: await col('pc'), outcomes: ['done', 'failed', 'cancelled', 'paused', 'stopped', 'running'] }
}

export async function shotOf(db, id) {
  const r = await db('run_history_shots').where('history_id', Number(id)).first('jpg')
  return r?.jpg ? Buffer.from(r.jpg) : null
}
