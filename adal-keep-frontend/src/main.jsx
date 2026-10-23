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
  if (import.meta.env.VITE_DEMO !== '1') return
  const { startFileWorker, seedFiles } = await import('./demo/files.js')
  const { demoDb } = await import('./demo/server.js')
  await startFileWorker()
  await seedFiles(demoDb())
}

boot().finally(() => ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
))

// Installable app (Install Adal Keep in the browser menu). Not in the demo build.
if ('serviceWorker' in navigator && import.meta.env.PROD && import.meta.env.VITE_DEMO !== '1') {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}))
}

// English (Settings → Language): shows the Amharic pages in English.
import('./lib/i18n.js').then(m => m.startLanguage())
