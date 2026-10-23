import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

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
