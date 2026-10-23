// Adal Keep as an installable app. This worker only makes the app
// installable: it caches nothing, so the app always shows the newest version.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => { /* the network answers, as without the worker */ })
