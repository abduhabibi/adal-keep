import './lib/phoneApp'
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
// The fonts are part of the app (no waiting for Google Fonts, works offline).
import '@fontsource-variable/dm-sans/index.css'
import '@fontsource/syne/600.css'
import '@fontsource/syne/700.css'
import '@fontsource/syne/800.css'
import './index.css'

// A page in a hidden tab does not need its every-few-seconds refreshes: they
// are skipped until the page is seen again (and done at once then). This keeps
// low-end PCs and the main PC quiet.
if (typeof document !== 'undefined') {
  const every = window.setInterval.bind(window)
  const later = new Set()
  window.setInterval = (fn, ms, ...args) => {
    if (typeof fn !== 'function' || !(ms < 60000)) return every(fn, ms, ...args)
    const run = () => fn(...args)
    return every(() => { if (document.hidden) later.add(run); else run() }, ms)
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    const due = [...later]; later.clear()
    due.forEach(run => { try { run() } catch {} })
  })
}

// Public demo: start the in-browser file server and draw the demo documents first.
async function boot() {
  if (import.meta.env.VITE_ADMIN === '1') return adminBoot()
  if (import.meta.env.VITE_PHONE === '1') return phoneBoot()
  if (import.meta.env.VITE_DEMO !== '1') return
  const { startFileWorker, seedFiles } = await import('./demo/files.js')
  const { demoDb } = await import('./demo/server.js')
  await startFileWorker()
  await seedFiles(demoDb())
}

// Phone app (vite --mode phone, inside adal-phone): connect.html pairs the
// phone (once, from anywhere) and opens these same pages, which work only
// through Supabase: live with the PC while it is on, else its online copy.
async function phoneBoot() {
  const q = new URLSearchParams(location.search)
  if (q.has('cloud')) sessionStorage.setItem('adal-cloud', '1')
  // Already paired: open at once (no detour through the pairing page).
  if (sessionStorage.getItem('adal-cloud') !== '1' && !q.has('pair')) {
    try { if (JSON.parse(localStorage.getItem('adal-pc') || 'null')?.cloud) sessionStorage.setItem('adal-cloud', '1') } catch {}
  }
  if (sessionStorage.getItem('adal-cloud') !== '1') {
    location.replace('/connect.html' + location.search)
    await new Promise(() => {})       // the page is leaving
  }
  window.__ADAL_CLOUD = true
  quietWhenHidden()
  const { startCloudDocuments, startLive, startMirror } = await import('./cloud/adapter.js')
  startCloudDocuments()
  startLive().catch(() => {})
  startMirror()        // the agency's text on the phone itself: pages open at once
  // Whether the office PC is live, and pairing: in Settings → This phone (no bar on the pages).
  window.__adalPcOnline = false
  window.addEventListener('adal-pc-online', (e) => { window.__adalPcOnline = !!e.detail })
  window.__adalPair = () => { sessionStorage.removeItem('adal-cloud'); location.replace('/connect.html?pair=1') }
  phoneUpdates()
}

// A newer phone app (Adal publishes it in Supabase, adal-updates/phone —
// only there; the GitHub repository is private): looked for at the
// start, whenever the app is opened again (at most every 10 minutes) and every
// 30 minutes. Android's "Update?" opens by itself once per new version; a red
// button in the bottom bar stays until it is installed.
// The published file's address in Supabase (signed in as this phone).
async function updateUrl(file) {
  const { updateLink } = await import('./cloud/adapter.js')
  return await updateLink(`phone/${file}`)
}
function phoneUpdates() {
  const plugin = window.Capacitor?.Plugins?.AdalDiscovery
  if (!plugin?.getVersion) return
  let last = 0, busy = false
  // Only when a new version exists: a small red button (bottom right); Settings → This phone shows it too.
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.style.cssText = 'display:none;position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));z-index:9999;background:#dc2626;color:#fff;border:0;border-radius:999px;font:bold 12px system-ui;padding:8px 14px;box-shadow:0 6px 18px rgba(220,38,38,.35)'
  document.body.appendChild(btn)
  const tell = (state) => { window.__adalUpdate = { ...(window.__adalUpdate || {}), ...state }; window.dispatchEvent(new CustomEvent('adal-update', { detail: window.__adalUpdate })) }
  const install = async (v) => {
    if (busy) return
    busy = true
    btn.textContent = '⬇ Downloading…'; tell({ busy: true })
    try {
      const r = await plugin.installUpdate({ url: await updateUrl('AdalKeep.apk') })
      btn.textContent = r?.needsPermission ? '⬆ Allow, then tap here' : `⬆ Update to ${v.versionName}`
    } catch { btn.textContent = `⬆ Update to ${v.versionName}` }
    busy = false; tell({ busy: false })
  }
  const check = async (force) => {
    if (!force && (document.hidden || Date.now() - last < 10 * 60000)) return
    last = Date.now()
    try {
      const mine = await plugin.getVersion()
      let v
      v = await (await fetch(await updateUrl('version.json'), { cache: 'no-store' })).json()
      const newer = v.versionCode > mine.versionCode
      tell({ mine: mine.versionName || mine.versionCode, latest: v.versionName, newer, checkedAt: Date.now() })
      if (!newer) { btn.style.display = 'none'; return }
      btn.style.display = ''
      btn.textContent = `⬆ Update to ${v.versionName}`
      btn.onclick = () => install(v)
      window.__adalInstallUpdate = () => install(v)
      const asked = `adal-update-${v.versionCode}`
      if (!sessionStorage.getItem(asked)) { sessionStorage.setItem(asked, '1'); install(v) }
    } catch {}
  }
  window.__adalCheckUpdate = () => check(true)
  const tick = () => check(); tick.__always = true
  setTimeout(check, 3000)
  setInterval(tick, 30 * 60000)
  document.addEventListener('visibilitychange', () => check())
}

// The phone does no work while the app is in the background: repeating
// timers (lists, counts …) wait, and run once when it is opened again.
// A timer marked fn.__always (the live link's heartbeat) keeps going.
function quietWhenHidden() {
  const real = window.setInterval.bind(window)
  const missed = new Set(), runs = new Map()
  window.setInterval = (fn, ms, ...args) => {
    if (typeof fn !== 'function' || fn.__always || !(ms >= 1000)) return real(fn, ms, ...args)
    const run = () => { if (document.hidden) missed.add(run); else fn(...args) }
    const id = real(run, ms)
    runs.set(id, run)
    return id
  }
  const clear = window.clearInterval.bind(window)
  window.clearInterval = (id) => { const r = runs.get(id); if (r) { missed.delete(r); runs.delete(id) } clear(id) }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return
    const due = [...missed]; missed.clear()
    due.forEach((f, i) => setTimeout(f, i * 30))   // spread out, not all at once
  })
}

// Adal Keep Admin (vite --mode admin, served by adal-admin on :4101): one
// agency's whole Adal Keep in its own window — through the relay while its PC
// is on, else its online copy. adal-admin answers /sb/… for that agency only.
async function adminBoot() {
  const q = new URLSearchParams(location.search)
  if (q.get('agency')) sessionStorage.setItem('adal-admin-agency', JSON.stringify({ id: q.get('agency'), name: q.get('name') || '' }))
  const a = JSON.parse(sessionStorage.getItem('adal-admin-agency') || 'null')
  if (!a?.id) { document.body.innerHTML = '<p style="font:16px system-ui;padding:40px">Open an agency from Adal Keep Admin.</p>'; await new Promise(() => {}) }
  window.__ADAL_CREDS = { url: `${location.origin}/sb`, anon: a.id, email: 'admin', password: 'admin', agency: a.id }
  window.__ADAL_CLOUD = true
  // The person working here is Adal support, not one of the agency's employees.
  try { localStorage.setItem('adal_active_employee', JSON.stringify({ id: -1, name: 'Adal support', username: 'adal', role: 'admin' })) } catch {}
  document.title = `${a.name || 'Agency'} — Adal Keep Admin`
  const { startCloudDocuments } = await import('./cloud/adapter.js')
  startCloudDocuments()
  const bar = document.createElement('div')
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#7c2d12;color:#fff;font:12px/1.3 system-ui,sans-serif;padding:6px 10px;display:flex;gap:8px;align-items:center'
  bar.innerHTML = `<b>👑 Adal Admin</b><span>· ${(a.name || 'Agency').replace(/[<>&]/g, '')} ·</span><span id="adal-admin-pc">…</span>`
  window.addEventListener('adal-pc-online', (e) => {
    bar.querySelector('#adal-admin-pc').textContent = e.detail ? 'its PC is on — changes happen at once' : 'its PC is off — online copy; changes wait for the PC'
    bar.style.background = e.detail ? '#4338ca' : '#7c2d12'
  })
  document.body.appendChild(bar)
  document.body.style.paddingBottom = '40px'
  if (q.get('to')) history.replaceState(null, '', q.get('to'))
}

boot().finally(() => ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
))

// Installable app (Install Adal Keep in the browser menu). Not in the demo build.
if ('serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.VITE_DEMO !== '1' && import.meta.env.VITE_PHONE !== '1' && import.meta.env.VITE_ADMIN !== '1') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}

// English (Settings → Language): shows the Amharic pages in English.
import('./lib/i18n.js').then(m => m.startLanguage())
