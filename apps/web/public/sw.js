const SHELL_CACHE = "forno-pos-shell-v2";
const STATIC_CACHE = "forno-pos-static-v2";
// Authenticated HTML is cached only after a successful online navigation. The
// install step contains public assets exclusively, avoiding cached redirects or
// authenticated API data.
const SHELL_URLS = ["/manifest.webmanifest", "/forno-pwa-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("forno-pos-") && ![SHELL_CACHE, STATIC_CACHE].includes(key)).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/login") || url.pathname.startsWith("/signup")) {
    event.respondWith(fetch(request));
    return;
  }
  if (url.pathname.startsWith("/_next/static/") || url.pathname === "/manifest.webmanifest" || url.pathname === "/forno-pwa-icon.svg") {
    event.respondWith(caches.open(STATIC_CACHE).then(async (cache) => {
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic") await cache.put(request, response.clone());
        return response;
      } catch {
        return cache.match(request);
      }
    }));
    return;
  }
  if (request.mode === "navigate" && (url.pathname === "/admin/pos" || url.pathname.startsWith("/offline-print/"))) {
    event.respondWith(fetch(request).then(async (response) => {
      if (response.ok) await (await caches.open(SHELL_CACHE)).put(url.pathname, response.clone());
      return response;
    }).catch(async () => (await caches.open(SHELL_CACHE)).match(url.pathname) || (await caches.open(SHELL_CACHE)).match("/admin/pos")));
  }
});
