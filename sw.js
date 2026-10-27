const CACHE_NAME = "cbtis170-asistencia-v3";
const APP_FILES = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.webmanifest",
    "./icon-192.png",
    "./icon-512.png"
];

self.addEventListener("install", event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(APP_FILES))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", event => {
    event.waitUntil(
        caches.keys().then(keys => Promise.all(
            keys.filter(key => key.startsWith("cbtis170-asistencia-") && key !== CACHE_NAME)
                .map(key => caches.delete(key))
        )).then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", event => {
    if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
    if (event.request.mode === "navigate") {
        event.respondWith(fetch(event.request).then(response => {
            if (!response.ok) return response;
            return caches.open(CACHE_NAME).then(cache => cache.put("./index.html", response.clone()))
                .then(() => response);
        }).catch(() => caches.match("./index.html")));
        return;
    }
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
});
