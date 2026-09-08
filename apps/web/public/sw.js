// Exists purely so Chrome treats BPMix as installable - installed PWAs get
// persistent File System Access permissions (survive reload/relaunch, no
// re-prompt), which a plain browser tab never does. No offline caching is
// attempted here (the app is inert without the user's own local/mounted
// files anyway, so there's nothing worth precaching) - this is a pure
// passthrough, deliberately with no cache-versioning/invalidation surface
// to maintain.
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
