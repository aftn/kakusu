// Minimal service worker for PWA installability.
// This app deliberately does NOT cache responses because it handles
// client-side encrypted data that should not be stored by SWs.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Only intercept same-origin requests; let cross-origin (e.g. Google CDN images) pass through natively.
  if (new URL(event.request.url).origin !== self.location.origin) return;
  // Network-only: simply pass through every request.
  event.respondWith(fetch(event.request));
});
