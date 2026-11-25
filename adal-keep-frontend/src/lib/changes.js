/**
 * Live pages: the PC says which tables changed the moment they change
 * (GET /api/changes on a PC, the live link on a phone), and every page that
 * shows them reloads at once:
 *   - onDataChange(tables, fn): a page's own reload, for the tables it shows;
 *   - every repeating refresh a page already has (setInterval, see main.jsx) that
 *     shows one of those tables also runs at once — so lists, counts and statuses everywhere follow.
 * A change made on this page itself is told at once too (no wait for the PC).
 */
import { off } from './offSwitch.js'

const listeners = new Set()
const ALL = null

/** fn runs (at most every `gap` ms) when one of `tables` changed; null = any. Returns the unsubscribe. */
export function onDataChange(tables, fn, gap = 800) {
  const want = tables ? new Set(tables) : ALL
  let last = 0, timer = null
  const l = (changed) => {
    if (want && !changed.includes('*') && !changed.some(t => want.has(t))) return
    const wait = Math.max(0, gap - (Date.now() - last))
    clearTimeout(timer)
    timer = setTimeout(() => { last = Date.now(); try { fn(changed) } catch {} }, wait)
  }
  listeners.add(l)
  return () => { clearTimeout(timer); listeners.delete(l) }
}

// What each address shows. Only what is known here is left out when other tables changed:
// anything else runs at every change, as before. [] = not from the database (its own timer looks).
// Off: "only" in the off switch.
const QUEUE = ['automation_queue', 'profile_automations', 'run_history']
const SHOWS = [
  [/^\/?(subscription\/status|pc-access\/pending|mobile\/join-requests|system\/update\/notice|transitions\/waiting-files|tasks\/reading|health)\b/, []],
  [/^\/?profiles(\/(list|brief))?$/, ['profiles', 'brokers']],
  [/^\/?brokers$/, ['brokers', 'profiles']],
  [/^\/?tasks(\/count)?$/, ['tasks']],
  [/^\/?notifications/, ['notifications', 'tasks']],
  [/^\/?automations\/stages$/, ['profiles', 'profile_fields', 'files', 'generated_cvs', 'whatsapp_sends', 'whatsapp_log', ...QUEUE]],
  [/^\/?automations\/(active|browsers|run-history)/, QUEUE],
  [/^\/?automations\/(attention|ready-for-submit)/, ['profiles', 'notifications', 'settings', ...QUEUE]],
  // Her page: whatever is about a girl, so everything but these.
  [/^\/?profiles\/\d+/, { not: ['tasks', 'notifications', 'chat', 'quick_links', 'branches', 'users', 'checklists', 'checklist_cells', 'checklist_profiles'] }],
  [/^\/?chat\//, ['chat', 'users', 'profiles']],
]
const showsAny = (url, tables) => {
  const s = SHOWS.find(([re]) => re.test(url.split('?')[0]))?.[1]
  return !s ? true : s.not ? tables.some(t => !s.not.includes(t)) : tables.some(t => s.includes(t))
}
/** Does a timer that asks these addresses show one of these tables? (not known yet = yes) */
export function concerns(asks, tables) {
  if (!asks?.size || tables.includes('*') || off('only')) return true
  return [...asks].some(u => showsAny(u, tables))
}

let refreshAll = () => {}
/** main.jsx hands over how to run every page's repeating refresh at once. */
export function setRefreshAll(fn) { refreshAll = fn }

let lastAll = 0, allTimer = null, told = new Set()
/** mine: a change made on this page — while the PC's live link is up its own word for it
 *  comes within a second and runs the timers; run here too, each click asked for everything twice. */
export function tellChanged(tables, { mine = false } = {}) {
  if (!tables?.length) return
  for (const l of listeners) l(tables)
  // (A CV sent on WhatsApp: only the WhatsApp page shows it, nothing else reloads.)
  if (tables.every(t => t === 'whatsapp_log')) return
  if (mine && typeof window !== 'undefined' && window.__adalLiveUp) return
  // The pages' own timers: once, soon (not once per change).
  for (const t of tables) told.add(t)
  if (allTimer) return
  allTimer = setTimeout(() => { allTimer = null; lastAll = Date.now(); const all = [...told]; told = new Set(); if (!document.hidden) refreshAll(all) }, Math.max(300, 2000 - (Date.now() - lastAll)))
}

// Which tables a write through the API touches (for the page's own changes).
const BY_PATH = [
  [/^\/?profiles\/\d+\/opened/, null],   // opening a profile is not a change
  [/^\/?checklists/, ['checklists', 'checklist_profiles', 'checklist_cells']],
  [/^\/?notes/, ['notes', 'profiles']],
  [/^\/?profiles\/\d+\/(fields|files)|^\/?files/, ['profile_fields', 'files']],
  [/^\/?profiles/, ['profiles', 'profile_fields']],
  [/^\/?brokers/, ['brokers', 'profiles']],
  [/^\/?tasks/, ['tasks']],
  [/^\/?notifications/, ['notifications']],
  [/automations|runs/, ['automation_queue', 'profile_automations', 'profiles']],
  [/^\/?chat\/(send|conversations\/[^/]+\/read|messages\/\d+|direct|groups)/, ['chat']],
]
export function tablesOfRequest(url = '') {
  const p = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').split('?')[0]
  return BY_PATH.find(([re]) => re.test(p))?.[1] || null
}

let started = false
export async function startChanges() {
  if (started) return
  started = true
  if (window.__ADAL_CLOUD) {
    // A phone: the PC's message arrives over the live link.
    try {
      const { onLive } = await import('../cloud/live.js')
      onLive((m) => { if (m?.t === 'changed') tellChanged(m.tables) })
    } catch {}
    return
  }
  if (!('EventSource' in window)) return
  const { appStream, changesStream, farWindow } = await import('./appStream.js')
  const shared = appStream()
  const open = () => {
    // On the main PC itself the window's one stream carries the changes (lib/appStream.js).
    const es = shared || (farWindow() ? changesStream() : new EventSource('/api/changes'))
    const got = (e) => { try { tellChanged(JSON.parse(e.data).tables) } catch {} }
    if (shared) es.addEventListener('changes', got)
    else es.onmessage = got
    // The PC restarted or the line dropped: the browser reconnects by itself;
    // when it is back, everything is refreshed once (changes may have been missed).
    let wasDown = false
    es.addEventListener('error', () => { wasDown = true; window.__adalLiveUp = false })
    es.addEventListener('open', () => { window.__adalLiveUp = true; if (wasDown) { wasDown = false; tellChanged(['*']) } })
    if (es.readyState === 1) window.__adalLiveUp = true
  }
  open()
}
