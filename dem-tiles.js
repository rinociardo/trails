// Browser side of the DEM: downloads elevation tiles and returns their pixels
// for dem.js. The last few decoded tiles are kept in memory (the planner asks
// again on every change). Downloaded tiles are also stored on the device (Cache
// Storage "trails-dem-tiles"; Terrain Tiles may be cached), so a walk in an area
// visited before has elevations with no signal. Map tiles are never stored here.

import { fillFromDem, tilePosition, sampleTile, decodeTerrarium } from './dem.js';
import { DEM } from './map-config.js';

const CACHE_TILES = 48; // decoded 256×256 tiles are 256 kB each: ≈12 MB at most
const cache = new Map(); // "z/x/y" -> Promise of the tile, oldest first

// On the device: at most this many tiles (≈100 kB each, so ≈60 MB); the oldest go first.
export const DEM_STORE = 'trails-dem-tiles';
const STORE_MAX_TILES = 600;
let putsSinceTrim = 0;

function openStore() {
    if (typeof caches === 'undefined') return Promise.resolve(null);
    return caches.open(DEM_STORE).catch(() => null);
}

function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let tile = cache.get(key);
    if (tile) {
        cache.delete(key); // most recently used goes to the end
    } else {
        tile = downloadTile(z, x, y);
        tile.catch(() => cache.delete(key)); // try again next time
    }
    cache.set(key, tile);
    if (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value);
    return tile;
}

const tileUrl = (z, x, y) => DEM.tiles.replace('{z}', z).replace('{x}', x).replace('{y}', y);

// The tile's PNG: from the device if stored, else downloaded (and stored).
async function tileResponse(z, x, y) {
    const url = tileUrl(z, x, y);
    const store = await openStore();
    const stored = await store?.match(url).catch(() => null);
    if (stored) return stored;
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error(`DEM tile ${z}/${x}/${y}: HTTP ${response.status}`);
    if (store) {
        store.put(url, response.clone()).then(() => {
            if (++putsSinceTrim >= 20) trimStore(store);
        }).catch(() => {}); // storage full: the tile still works for now
    }
    return response;
}

async function trimStore(store) {
    putsSinceTrim = 0;
    const keys = await store.keys();
    for (const request of keys.slice(0, Math.max(0, keys.length - STORE_MAX_TILES))) await store.delete(request);
}

async function downloadTile(z, x, y) {
    const response = await tileResponse(z, x, y);
    // No colour conversion: the pixel values are elevations, not colours.
    const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return { width: canvas.width, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}

// Fills missing elevations of points from the DEM: see fillFromDem().
export function fillElevationsFromDem(points) {
    return fillFromDem(points, { zoom: DEM.sampleZoom, tileSize: DEM.tileSize, encoding: DEM.encoding, loadTile });
}

// ---------- Elevation at the current position (every GPS fix) ----------

const RETRY_MS = 20_000;  // a tile that failed (no signal) is asked for again after this
const ready = new Map();  // "x/y" -> { tile } | { failedAt } | { loading: true }
const READY_TILES = 9;

function requestTile(x, y) {
    const key = `${x}/${y}`;
    const entry = ready.get(key);
    if (entry?.tile || entry?.loading) return;
    if (entry?.failedAt && Date.now() - entry.failedAt < RETRY_MS) return;
    ready.set(key, { loading: true, failedAt: entry?.failedAt });
    loadTile(DEM.sampleZoom, x, y)
        .then((tile) => ready.set(key, { tile }))
        .catch(() => ready.set(key, { failedAt: Date.now() }))
        .finally(() => {
            while (ready.size > READY_TILES) ready.delete(ready.keys().next().value);
        });
}

// Back online: tiles that failed are asked for again at the next fix.
if (typeof window !== 'undefined') {
    window.addEventListener('online', () => {
        for (const [key, entry] of ready) if (entry.failedAt && !entry.loading) ready.delete(key);
    });
}

// Stores the 8 tiles around this one, so a little signal goes a long way.
const prefetched = new Set();
function prefetchAround(x, y) {
    for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
            const key = `${x + dx}/${y + dy}`;
            if ((dx || dy) && !prefetched.has(key)) {
                prefetched.add(key);
                tileResponse(DEM.sampleZoom, x + dx, y + dy).catch(() => prefetched.delete(key));
            }
        }
    }
}

// DEM elevation here, at once: { ele } when the tile is at hand, otherwise
// { status: 'loading' } (asked for; a later fix gets it) or { status:
// 'unavailable' } (not stored on the device and no signal).
export function elevationAt(lat, lon) {
    const pos = tilePosition(lat, lon, DEM.sampleZoom, DEM.tileSize);
    const key = `${pos.x}/${pos.y}`;
    requestTile(pos.x, pos.y);
    const entry = ready.get(key);
    if (entry?.tile) {
        ready.delete(key); // most recently used goes to the end
        ready.set(key, entry);
        prefetchAround(pos.x, pos.y);
        return { ele: Math.round(sampleTile(entry.tile, pos.px, pos.py, decodeTerrarium) * 10) / 10 };
    }
    return { status: entry?.failedAt ? 'unavailable' : 'loading' };
}

// Settings › Elevation: how many tiles are stored, and Clear.
export async function demStoreCount() {
    const store = await openStore();
    return store ? (await store.keys()).length : null;
}

export async function clearDemStore() {
    if (typeof caches === 'undefined') return;
    await caches.delete(DEM_STORE);
    prefetched.clear();
}

export const DEM_NAME = DEM.name;
export const DEM_CREDITS = DEM.credits;
