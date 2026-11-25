import axios from 'axios'

const api = axios.create({
  baseURL: '/api', // Vite proxy will forward this to http://localhost:4000/api
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true, // Required for cookies/sessions
})

// The same GET asked again while the first is on its way shares its answer:
// pages and side panels that load the same list at once cost one request.
{
  const get = api.get.bind(api)
  const inflight = new Map()
  api.get = (url, config = {}) => {
    if (config.responseType && config.responseType !== 'json') return get(url, config)
    const key = url + '?' + JSON.stringify(config.params || {})
    if (inflight.has(key)) return inflight.get(key)
    const p = get(url, config).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }
}

// Every page's data kept on this device (asked for on 2026-11-09): the first
// time a page asks for something on a visit, what was saved last time answers
// at once and the PC's fresh answer is saved behind it (a different one
// raises "adal-data-fresh": the layout shows the page again with it). Asked
// again on the same visit (a page checking every few seconds), or right after
// a change was sent, the PC answers. Live things always come from the PC.
// CVs and one girl's own page too: a form filled from an old copy would show (and save) old values.
const LIVE = /^\/?(cv\/|profiles\/\d+|automations\/(active|\d+)|transitions|chat\/(messages|typing|unlock|file|image|search)|subscription|setup|auth|plan\/|whatsapp\/(notify|bulk|cv|own)|system|updates|health|app\/|captcha|pc-access|mobile|tutor|sessions|tower)/
if (import.meta.env.VITE_DEMO !== '1') {
  const get = api.get
  const asked = new Set()
  let dirtyUntil = 0
  api.adalVisit = () => asked.clear()
  api.adalDirty = () => { dirtyUntil = Date.now() + 8000 }
  const keep = (key, r) => { import('../lib/idbStore').then(s => s.idbPut(key, r.data)).catch(() => {}); return r }
  api.get = (url, config = {}) => {
    const plain = !config.adalNoCache && (!config.responseType || config.responseType === 'json') && !LIVE.test(String(url))
    if (!plain) return get(url, config)
    return import('../lib/idbStore').then(async ({ idbGet, answerKey }) => {
      const key = answerKey(api.defaults.baseURL, url, config.params)
      if (asked.has(key) || Date.now() < dirtyUntil) { asked.add(key); return get(url, config).then(r => keep(key, r)) }
      asked.add(key)
      const net = get(url, config).then(r => keep(key, r))
      const old = await idbGet(key)
      if (old === undefined) return net
      net.then(r => { if (JSON.stringify(r.data) !== JSON.stringify(old)) window.dispatchEvent(new CustomEvent('adal-data-fresh', { detail: { url } })) }).catch(() => {})
      return { data: old, status: 200, statusText: 'OK (kept on this device)', headers: {}, config, fromDevice: true }
    })
  }
  // A change sent to the PC: what is asked next comes from the PC.
  // (Not the messages that change nothing: "still here", typing, opened, a check.)
  const QUIET = /(ping|warm|cv\/(preview|prepare)|typing|device-resume|opened|plan\/refresh|alive|heartbeat|seen|read)\b/
  api.interceptors.request.use((c) => { if (c.method && c.method.toLowerCase() !== 'get' && !QUIET.test(String(c.url))) dirtyUntil = Date.now() + 8000; return c })
}

// How fast the PC answers: on a slow line (answers taking 1.5 s+ on average)
// the pages' repeating refreshes ask less often (main.jsx).
{
  let avg = 0
  api.interceptors.request.use((c) => { if (!c.responseType || c.responseType === "json") c.__t0 = performance.now(); return c })
  const took = (c) => { if (!c?.__t0) return; avg = avg ? avg * 0.8 + (performance.now() - c.__t0) * 0.2 : performance.now() - c.__t0; window.__adalSlowLine = avg > 1500 }
  api.interceptors.response.use((r) => { took(r.config); return r }, (e) => { took(e?.config); return Promise.reject(e) })
}

// An Adal Companion (or another computer) let in with the main PC's number
// keeps, in this window, its key and what it joined with (the number, its own
// id from AdalKeep.exe, its online account). Asked on 2026-11-19 ("it is
// logging out fast"): the key lived only in a cookie of one address, so a new
// address of the main PC (the router, Tailscale), a cleared cookie or a new
// browser profile meant typing the number again. Now the key goes with every
// call (X-Adal-PC) and, when even that is gone, the window comes back in by
// itself with the number (PcAccessGate). Only "Log out of this main PC"
// (lib/companionOnline.js) or a suspension on the main PC ends it.
const JOIN = 'adal_pc_join', KEY = 'adal_pc_key'
const isMainItself = () => typeof location !== 'undefined' && ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)
export function joinInfo() {
  let j = {}
  try { j = JSON.parse(localStorage.getItem(JOIN) || '{}') || {} } catch {}
  return j
}
export function rememberJoin(j, key) {
  try {
    const clean = {}
    for (const k of ['number', 'cid', 'device']) if (j?.[k]) clean[k] = String(j[k]).slice(0, 128)
    localStorage.setItem(JOIN, JSON.stringify(clean))
    if (key) localStorage.setItem(KEY, key)
  } catch {}
}
export function forgetJoin() { try { localStorage.removeItem(JOIN); localStorage.removeItem(KEY) } catch {} }
// Handed over in the address (#adal_number, #adal_cid, #adal_device — never sent to a server): kept at once.
if (typeof location !== 'undefined' && !isMainItself() && import.meta.env.VITE_PHONE !== '1' && import.meta.env.VITE_ADMIN !== '1') {
  try {
    const h = new URLSearchParams(location.hash.slice(1))
    if (h.get('adal_number')) rememberJoin({ ...joinInfo(), number: h.get('adal_number'), ...(h.get('adal_cid') ? { cid: h.get('adal_cid') } : {}), ...(h.get('adal_device') ? { device: h.get('adal_device') } : {}) })
  } catch {}
}
api.interceptors.request.use((config) => {
  if (!isMainItself()) { try { const k = localStorage.getItem(KEY); if (k) config.headers['X-Adal-PC'] = k } catch {} }
  return config
})

// Who is working (the employee chosen on this PC): the Trash shows who deleted what.
api.interceptors.request.use((config) => {
  try {
    const e = JSON.parse(localStorage.getItem('adal_active_employee') || 'null')
    const who = e?.name || e?.full_name || e?.username
    if (who) config.headers['X-Adal-Who'] = encodeURIComponent(String(who).slice(0, 80))
    // Her key (given when she signed in): the PC checks her staff role with it.
    // A phone has none: it works as whoever is signed in on its PC (X-Adal-Phone).
    if (import.meta.env.VITE_PHONE === '1' || window.Capacitor?.isNativePlatform?.()) config.headers['X-Adal-Phone'] = '1'
    else if (e?.staff_token) config.headers['X-Adal-Staff'] = e.staff_token
  } catch {}
  return config
})

// Public demo build (vite --mode demo): answer in the browser with made-up
// data instead of calling a server. See src/demo/server.js.
if (import.meta.env.VITE_DEMO === '1') {
  api.interceptors.request.use(async (config) => {
    config.adapter = (await import('../demo/server.js')).demoAdapter
    return config
  })
}

// Phone app with its PC off or far away: the pages work on the agency's
// online copy (src/cloud/adapter.js) instead of the PC.
if (import.meta.env.VITE_PHONE === '1' || import.meta.env.VITE_ADMIN === '1') {
  api.interceptors.request.use(async (config) => {
    if (window.__ADAL_CLOUD === true) config.adapter = (await import('../cloud/adapter.js')).cloudAdapter
    return config
  })
}

// Global error handler (optional but helpful for debugging)
api.interceptors.response.use(
  (response) => {
    // A change made here: this page and its neighbours reload at once.
    const m = String(response.config?.method || 'get').toLowerCase()
    if (m !== 'get' && m !== 'head') {
      import('../lib/changes.js').then(c => { const t = c.tablesOfRequest(response.config?.url); if (t) c.tellChanged(t) }).catch(() => {})
    }
    return response
  },
  (error) => {
    // Trial over and not unlocked: the app swaps itself for the lock screen.
    if (error.response?.status === 402 && error.response?.data?.error === 'locked') {
      window.dispatchEvent(new Event('adal-locked'))
    }
    // Another computer this PC has not said "Yes" to yet: ask first (PcAccessGate).
    // Suspended by the main PC (Settings → Connected devices): cut off, with its own screen (App.jsx).
    if (error.response?.status === 403 && error.response?.data?.suspended) window.dispatchEvent(new Event('adal-suspended'))
    if (error.response?.status === 401 && error.response?.data?.pc_access) {
      window.dispatchEvent(new Event('adal-pc-access'))
    }
    if (error.response?.status === 503) {
      console.warn('⚠️ Not available right now:', error.config?.url, error.response?.data?.error || '')
    } else if (error.code === 'ERR_NETWORK') {
      console.error('❌ Cannot connect to backend. Is the server running on port 4000?')
    }
    return Promise.reject(error)
  }
)

export default api