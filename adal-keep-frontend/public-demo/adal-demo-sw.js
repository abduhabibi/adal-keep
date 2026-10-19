// Adal Keep demo only: serves /api/files/:id/{thumbnail,download} from Cache
// Storage, where the demo put its made-up documents. The real app never
// registers this worker.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== self.location.origin || !/^\/api\/files\/\d+\/(thumbnail|download)$/.test(url.pathname)) return
  e.respondWith((async () => {
    const hit = await caches.match(url.pathname, { cacheName: 'adal-demo-files' })
    if (hit) return hit
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="#e2e8f0"/><text x="150" y="160" font-size="20" text-anchor="middle" fill="#64748b" font-family="sans-serif">demo file</text></svg>'
    return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml' } })
  })())
})
