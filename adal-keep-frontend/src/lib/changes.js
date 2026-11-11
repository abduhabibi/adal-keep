/**
 * Live pages: the PC says which tables changed the moment they change
 * (GET /api/changes on a PC, the live link on a phone), and every page that
 * shows them reloads at once:
 *   - onDataChange(tables, fn): a page's own reload, for the tables it shows;
 *   - every repeating refresh a page already has (setInterval, see main.jsx)
 *     also runs at once — so lists, counts and statuses everywhere follow.
 * A change made on this page itself is told at once too (no wait for the PC).
 */
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

let refreshAll = () => {}
/** main.jsx hands over how to run every page's repeating refresh at once. */
export function setRefreshAll(fn) { refreshAll = fn }

let lastAll = 0, allTimer = null
export function tellChanged(tables) {
  if (!tables?.length) return
  for (const l of listeners) l(tables)
  // The pages' own timers: once, soon (not once per change).
  if (allTimer) return
  allTimer = setTimeout(() => { allTimer = null; lastAll = Date.now(); if (!document.hidden) refreshAll() }, Math.max(300, 2000 - (Date.now() - lastAll)))
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
  const open = () => {
    const es = new EventSource('/api/changes')
    es.onmessage = (e) => { try { tellChanged(JSON.parse(e.data).tables) } catch {} }
    // The PC restarted or the line dropped: the browser reconnects by itself;
    // when it is back, everything is refreshed once (changes may have been missed).
    let wasDown = false
    es.onerror = () => { wasDown = true; window.__adalLiveUp = false }
    es.onopen = () => { window.__adalLiveUp = true; if (wasDown) { wasDown = false; tellChanged(['*']) } }
  }
  open()
}
