const CACHE_PREFIX = "greek-vocabulary:";
const CACHE_NAME = CACHE_PREFIX + "v15";
const FILES = ["./", "./index.html", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(FILES)));
});

// Old caches are removed, but the last saved course dictionaries move to the new cache first,
// so the lessons stay available offline after an update.
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const old = (await caches.keys()).filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME);
    const cache = await caches.open(CACHE_NAME);
    if (!(await cache.match("./lessons.js"))) {
      for (const key of old) {
        const saved = await caches.match("./lessons.js", { cacheName: key });
        if (saved) { await cache.put("./lessons.js", saved).catch(() => {}); break; }
      }
    }
    await Promise.all(old.map(key => caches.delete(key)));
  })());
});

// The course dictionaries (lessons.js) come from the network when possible and from the cache offline.
function lessonsResponse(request) {
  return fetch(request).then(async response => {
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put("./lessons.js", response.clone()).catch(() => {});
    }
    return response;
  }).catch(async () =>
    await caches.match("./lessons.js", { cacheName: CACHE_NAME }) || Response.error());
}

self.addEventListener("fetch", event => {
  if (event.request.mode !== "navigate") {
    const url = new URL(event.request.url);
    if (event.request.method === "GET" && url.origin === self.location.origin &&
        url.pathname === new URL("./lessons.js", self.registration.scope).pathname) {
      event.respondWith(lessonsResponse(event.request));
    }
    return;
  }

  const url = new URL(event.request.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin ||
      (url.pathname !== scope.pathname && url.pathname !== scope.pathname + "index.html")) return;

  event.respondWith((async () => {
    try {
      const response = await fetch(event.request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        await cache.put("./", response.clone()).catch(() => {});
      }
      return response;
    } catch {
      return await caches.match("./", { cacheName: CACHE_NAME }) || Response.error();
    }
  })());
});
