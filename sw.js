// Offline support for the app itself (not map tiles).
// Bump VERSION on every release: it names the cache and is shown in Settings.
const VERSION = '0.7.0';
const CACHE_PREFIX = 'trails-';
const CACHE = `${CACHE_PREFIX}${VERSION}`;

// How long to wait for the network before using the saved copy (weak signal).
const NETWORK_TIMEOUT_MS = 3000;

const APP_FILES = [
    './',
    './index.html',
    './app.js',
    './geo.js',
    './gpx.js',
    './elevation.js',
    './dem.js',
    './dem-tiles.js',
    './plan.js',
    './planner.js',
    './tracker.js',
    './profile-chart.js',
    './map-view.js',
    './map-config.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png',
    './icons/favicon-32.png',
    './vendor/maplibre-gl/maplibre-gl.mjs',
    './vendor/maplibre-gl/maplibre-gl-shared.mjs',
    './vendor/maplibre-gl/maplibre-gl-worker.mjs',
    './vendor/maplibre-gl/maplibre-gl.css',
    './samples/sample-loop.gpx',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            // reload: skip the browser's HTTP cache so we store the files of this version.
            .then((cache) => cache.addAll(APP_FILES.map((url) => new Request(url, { cache: 'reload' }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            // Only our own caches: other apps on the same github.io site share this storage.
            .then((keys) => Promise.all(keys
                .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
                .map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('message', (event) => {
    if (event.data?.type === 'GET_VERSION') {
        event.source?.postMessage({ type: 'VERSION', version: VERSION });
    }
});

// Network first, so a new version shows up as soon as there is signal;
// the saved copy is used when offline or when the network is too slow.
async function networkFirst(request) {
    const cache = await caches.open(CACHE);
    const network = fetch(request).then((response) => {
        if (response.ok) cache.put(request, response.clone());
        return response;
    });
    network.catch(() => {}); // handled below; avoid "unhandled rejection" noise
    const timeout = new Promise((_, reject) => setTimeout(reject, NETWORK_TIMEOUT_MS));
    try {
        return await Promise.race([network, timeout]);
    } catch {
        const cached = await cache.match(request, { ignoreSearch: true }) ||
            (request.mode === 'navigate' && await cache.match('./index.html'));
        return cached || network;
    }
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    // Map tiles and other sites go straight to the network (no offline tiles yet).
    if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
    event.respondWith(networkFirst(request));
});
