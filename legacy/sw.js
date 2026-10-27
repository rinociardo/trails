const CACHE_NAME = 'scan-trails-v1';
const ASSETS_TO_CACHE = [
    './index.html',
    './app.js',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
    'https://unpkg.com/osmtogeojson@3.0.0-beta.5/osmtogeojson.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(ASSETS_TO_CACHE);
        })
    );
});

self.addEventListener('fetch', (event) => {
    // Skip Overpass API calls from service worker cache interception (handled by IndexedDB instead)
    if (event.request.url.includes('overpass-api.de')) {
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            return cachedResponse || fetch(event.request);
        })
    );
});