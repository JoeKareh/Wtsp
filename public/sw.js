// Minimal service worker: makes the app installable ("Add to Home screen" / Android app wrapper). It deliberately caches nothing,
// so customers can never be stuck on an old version or see another workspace's data from a cache.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network only */ });
