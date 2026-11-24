/**
 * robotBrowsers.js — the sidebar's "Browsers" (asked on 2026-11-21: "that's
 * what I mean by Adal Browser"). Every robot browser that works now, on any PC
 * of the office: its site, the girl, the PC it works on and how it is doing.
 * They all work out of sight; a click opens the live view (frames from the
 * tab, the person's mouse, keys, scroll and paste back to it), so the portals
 * are worked only through Adal Keep. The robots are driven from the main PC,
 * so this list is the same on every PC that opens Adal Keep.
 */
import os from 'os'

const SITES = [
  [/^musaned/, 'Musaned'], [/^wafid/, 'Wafid'], [/^tasheer/, 'Tasheer'], [/^(mofa|visa)/, 'Enjaz'],
  [/^insurance/, 'Insurance'], [/^epro/, 'EPRO'], [/^(police|lmis|contract_import|delete_labour)/, 'LMIS'],
]
export const siteName = (workflowId) => SITES.find(([r]) => r.test(String(workflowId || '')))?.[1] || String(workflowId || 'Robot')

// Other live tabs (a move's browser, Transitions): key → { page, site, girl, pc, status, at }.
const extra = new Map()
export function registerLiveTab(key, page, info = {}) {
  extra.set(String(key), { page, at: Date.now(), ...info })
  try { page.once?.('close', () => { if (extra.get(String(key))?.page === page) extra.delete(String(key)) }) } catch {}
}
export const updateLiveTab = (key, info) => { const t = extra.get(String(key)); if (t) Object.assign(t, info) }
export const forgetLiveTab = (key) => extra.delete(String(key))
export function liveTabOf(key) {
  const t = extra.get(String(key))
  if (!t || t.page?.isClosed?.()) return null
  return t.page
}

const STATUS = { running: 'Working', paused: 'Waiting for you', pending: 'Starting' }

/**
 * Every robot browser now. deps (tests): devices (the Companions there),
 * waiting (attention.js), hasTab(runId).
 */
export async function listBrowsers(db, deps = {}) {
  const devices = deps.devices || (await import('./remoteBrowsers.js')).liveDevices()
  const waits = deps.waiting || (await import('./attention.js')).waiting()
  const hasTab = deps.hasTab || (await import('./tabManager.js')).tabOfRun
  const nameOf = (id) => id ? (devices.find(d => d.id === id)?.name || 'a PC not on the network now') : (deps.hostname || os.hostname())
  const since = new Date(Date.now() - 6 * 3600e3).toISOString()
  const rows = await db('automation_queue as q').leftJoin('profiles as p', 'p.id', 'q.profile_id')
    .whereIn('q.status', ['running', 'paused', 'pending'])
    .where(function () { this.whereIn('q.status', ['running']).orWhere('q.updated_at', '>', since) })
    .orderBy('q.id', 'desc').limit(40)
    .select('q.id', 'q.workflow_id', 'q.status', 'q.context', 'q.profile_id', 'q.pause_reason', 'q.started_at', 'q.updated_at', 'p.full_name')
  const out = []
  for (const r of rows) {
    let ctx = {}
    try { ctx = JSON.parse(r.context || '{}') } catch {}
    const tab = !!hasTab(r.id)
    // A pending run with no tab yet is not a browser; a paused one keeps its tab.
    if (r.status === 'pending' && !tab) continue
    if (r.status === 'paused' && !tab) continue
    const dev = String(ctx.on_device || '')
    const w = waits.find(x => x.run_id === r.id)
    out.push({
      key: String(r.id), run_id: r.id, site: siteName(r.workflow_id), workflow_id: r.workflow_id,
      girl: r.full_name || '', profile_id: r.profile_id, pc: nameOf(dev), pc_id: dev, remote: !!dev,
      status: w ? 'Needs you' : STATUS[r.status] || r.status, needs_you: !!w, task: w ? w.title : null,
      at: new Date(r.started_at || r.updated_at || Date.now()).getTime(),
    })
  }
  // Each site's sign-in tab (Morning sign-in, Wafid on standby), by site and account — unless a run works in it now.
  const signIns = deps.signIns || await (async () => {
    const k = await import('./sessionKeeper.js')
    const list = k.signInTabs()
    const t = await (await import('./tasheerSession.js')).siteTab('site-tasheer').catch(() => null)
    if (t && !list.some(x => x.page === t)) list.push({ key: 'site-tasheer', page: t, site: 'Tasheer', girl: '', status: k.kept.tasheer?.signedIn ? 'Signed in' : 'Sign in', needs_you: !k.kept.tasheer?.signedIn, task: k.kept.tasheer?.signedIn ? null : 'Sign in to Tasheer: type the captcha and sign in' })
    return list
  })().catch(() => [])
  const runIds = new Set(out.map(b => b.run_id))
  for (const t of signIns) {
    if (t.run_id && runIds.has(t.run_id)) continue
    out.push({ key: t.key, run_id: null, site: t.site, girl: t.girl || '', pc: nameOf(''), pc_id: '', remote: false, sign_in: true, status: t.status, needs_you: !!t.needs_you, task: t.task || null, at: 0 })
  }
  for (const [key, t] of extra) {
    if (t.page?.isClosed?.()) { extra.delete(key); continue }
    out.push({ key, run_id: null, site: t.site || 'Browser', girl: t.girl || '', pc: nameOf(t.pc_id || ''), pc_id: t.pc_id || '', remote: !!t.pc_id, status: t.status || 'Working', needs_you: !!t.needs_you, task: t.task || null, at: t.at })
  }
  return out
}

export function _resetForTest() { extra.clear() }
