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
const LIVE = /^\/?(automations\/(active|\d+)|transitions|chat\/(messages|typing|unlock|file|image|search)|subscription|setup|auth|plan\/|whatsapp\/(notify|bulk)|system|updates|health|app\/|captcha|pc-access|mobile|tutor|sessions)/
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
  const QUIET = /(ping|typing|device-resume|opened|plan\/refresh|alive|heartbeat|seen|read)\b/
  api.interceptors.request.use((c) => { if (c.method && c.method.toLowerCase() !== 'get' && !QUIET.test(String(c.url))) dirtyUntil = Date.now() + 8000; return c })
}

// Who is working (the employee chosen on this PC): the Trash shows who deleted what.
api.interceptors.request.use((config) => {
  try {
    const e = JSON.parse(localStorage.getItem('adal_active_employee') || 'null')
    const who = e?.name || e?.full_name || e?.username
    if (who) config.headers['X-Adal-Who'] = encodeURIComponent(String(who).slice(0, 80))
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
    if (error.response?.status === 401 && error.response?.data?.pc_access) {
      window.dispatchEvent(new Event('adal-pc-access'))
    }
    if (error.response?.status === 503) {
      console.error('⚠️ Server is locked due to hardware mismatch.')
    } else if (error.code === 'ERR_NETWORK') {
      console.error('❌ Cannot connect to backend. Is the server running on port 4000?')
    }
    return Promise.reject(error)
  }
)

export default api