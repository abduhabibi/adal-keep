/**
 * bySite.js — the Robots page by site (the owner, 2026-11-27): Musaned, Wafid, Enjaz, Tasheer and LMIS, each with its
 * tasks waiting and working and its last results. Each task goes to its site's section; one of another site
 * (insurance, a move) to "Other". Off: ADAL_ROBOTS_BY_SITE=0 (the page as before).
 */
export const bySiteOn = (env = process.env) => env.ADAL_ROBOTS_BY_SITE !== '0'

export const SITE_NAMES = { musaned: 'Musaned', wafid: 'Wafid', mofa: 'Enjaz', tasheer: 'Tasheer', lmis: 'LMIS', other: 'Other' }
const OF = [[/^musaned/, 'musaned'], [/^wafid/, 'wafid'], [/^(mofa|visa|enjaz_)/, 'mofa'], [/^tasheer/, 'tasheer'], [/^(police|lmis|contract_import|delete_labour)/, 'lmis']]
/** The site a task works on. Pure. */
export const siteOfTask = (workflowId) => OF.find(([re]) => re.test(String(workflowId || '')))?.[1] || 'other'

const OPEN = ['pending', 'running', 'paused']
const lastWord = (log) => { try { const l = JSON.parse(log || '[]'); return String(l[l.length - 1]?.msg || '').slice(0, 200) } catch { return '' } }

/** → { sites: [{ key, name, queue: [...], last: [...] }] } (Other only when it has something). */
export async function bySite(db, { lastPerSite = 5, days = 3, skipped = [] } = {}) {
  const pick = ['q.id', 'q.workflow_id', 'q.status', 'q.pause_reason', 'q.created_at', 'q.started_at', 'q.finished_at', 'q.updated_at', 'q.profile_id', 'p.full_name']
  const open = await db('automation_queue as q').leftJoin('profiles as p', 'p.id', 'q.profile_id').whereIn('q.status', OPEN)
    .where(w => w.whereNull('q.pause_reason').orWhere('q.pause_reason', 'not like', 'with-run-%')).orderBy('q.id', 'asc').limit(300).select(pick)
  const since = new Date(Date.now() - days * 864e5).toISOString()
  const ended = await db('automation_queue as q').leftJoin('profiles as p', 'p.id', 'q.profile_id').whereIn('q.status', ['done', 'failed', 'cancelled'])
    .where('q.updated_at', '>=', since).orderBy('q.updated_at', 'desc').limit(400).select([...pick, 'q.log'])
  const row = (r) => ({ id: r.id, workflow: r.workflow_id, status: r.status, why: r.pause_reason || '', name: r.full_name || '', profile_id: r.profile_id, at: r.finished_at || r.started_at || r.updated_at || r.created_at })
  const sites = Object.keys(SITE_NAMES).map(key => ({ key, name: SITE_NAMES[key], queue: [], last: [], skipped: [] }))
  const at = (k) => sites.find(s => s.key === k)
  for (const r of open) at(siteOfTask(r.workflow_id)).queue.push(row(r))
  for (const r of ended) { const s = at(siteOfTask(r.workflow_id)); if (s.last.length < lastPerSite) s.last.push({ ...row(r), said: r.status === 'done' ? '' : lastWord(r.log) }) }
  for (const k of skipped) { const s = at(siteOfTask(k.workflow)); if (s.skipped.length < 5) s.skipped.push(k) }
  return { sites: sites.filter(s => s.key !== 'other' || s.queue.length || s.last.length || s.skipped.length) }
}
