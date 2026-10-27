import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
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

// Phone app (vite --mode phone, inside adal-phone): connect.html finds the PC
// and opens it; when the PC cannot be reached it comes back here (?cloud=1)
// and the same pages work on the online copy.
async function phoneBoot() {
  const q = new URLSearchParams(location.search)
  if (q.has('cloud')) sessionStorage.setItem('adal-cloud', '1')
  if (sessionStorage.getItem('adal-cloud') !== '1') {
    location.replace('/connect.html' + location.search)
    await new Promise(() => {})       // the page is leaving
  }
  window.__ADAL_CLOUD = true
  const { startCloudDocuments } = await import('./cloud/adapter.js')
  startCloudDocuments()
  const bar = document.createElement('div')
  bar.id = 'adal-cloud-bar'
  const OFF = '☁️ The PC is off — you see the online copy. Changes are done when the PC is on.'
  const ON = '🌐 Connected to the office PC through the internet — everything works.'
  bar.innerHTML = `<span>${OFF}</span> <button type="button">Try the PC</button>`
  window.addEventListener('adal-pc-online', (e) => {
    bar.querySelector('span').textContent = e.detail ? ON : OFF
    bar.style.background = e.detail ? '#4338ca' : '#0f766e'
  })
  bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#0f766e;color:#fff;font:12px/1.3 system-ui,sans-serif;padding:6px 10px;display:flex;gap:8px;align-items:center;justify-content:space-between'
  const btn = bar.querySelector('button')
  btn.style.cssText = 'background:#fff;color:#0f766e;border:0;border-radius:6px;padding:4px 8px;font-weight:600;white-space:nowrap'
  btn.onclick = () => { sessionStorage.removeItem('adal-cloud'); location.replace('/connect.html') }
  document.body.appendChild(bar)
  document.body.style.paddingBottom = '40px'
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
