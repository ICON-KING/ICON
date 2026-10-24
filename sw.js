const CACHE_NAME = "mythic-shell-v4";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/icon.svg?v=8", "/icon-192.png?v=8", "/icon-512.png?v=8", "/apple-touch-icon.png?v=8", "/favicon.ico?v=8", "/safari-pinned-tab.svg?v=8", "/manifest.webmanifest?v=8"];


self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data ? event.data.json() : {};
    } catch {
      payload = { body: event.data ? event.data.text() : "" };
    }
    const title = typeof payload.title === "string" && payload.title.trim()
      ? payload.title.slice(0, 100)
      : "MYTHIC · 새 소식";
    const body = typeof payload.body === "string" ? payload.body.slice(0, 180) : "커뮤니티에 새로운 소식이 있습니다.";
    let target = "/";
    try {
      const candidate = new URL(typeof payload.url === "string" ? payload.url : "/", self.location.origin);
      if (candidate.origin === self.location.origin) target = candidate.pathname + candidate.search + candidate.hash;
    } catch {}
    await self.registration.showNotification(title, {
      body,
      icon: "/icon-192.png?v=8",
      badge: "/favicon.ico?v=8",
      tag: typeof payload.tag === "string" ? payload.tag.slice(0, 100) : "mythic-push",
      renotify: false,
      data: { url: target }
    });
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    let target;
    try {
      const path = event.notification.data && typeof event.notification.data.url === "string"
        ? event.notification.data.url
        : "/";
      target = new URL(path, self.location.origin);
      if (target.origin !== self.location.origin) target = new URL("/", self.location.origin);
    } catch {
      target = new URL("/", self.location.origin);
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if ("focus" in client) {
        await client.navigate(target.href).catch(() => {});
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target.href);
  })());
});

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put("/index.html", copy));
        }
        return response;
      }).catch(async () => (await caches.match(request)) || (await caches.match("/index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});