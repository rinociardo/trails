// Trail routing for the planner. The planner only calls routeBetween(), so
// another routing service can replace openrouteservice by changing this file
// and ROUTER in map-config.js. Never throws: every failure comes back as a reason.

import { ROUTER } from './map-config.js';

export const ROUTER_NAME = ROUTER.name;
export const ROUTER_LIMITS = ROUTER.limits;
export const ROUTER_ATTRIBUTION = ROUTER.attribution;
export const ROUTER_SIGNUP_URL = ROUTER.signupUrl;

const CACHE_SIZE = 200; // routes kept in memory: undo/redo and re-drawing cost no requests
const cache = new Map();
const cacheKey = (a, b) => [a.lat, a.lon, b.lat, b.lon].map((v) => v.toFixed(6)).join(',');

// Path along trails from a to b ({ lat, lon }), with the user's key.
// Resolves { ok: true, path: [{ lat, lon }] } (from the nearest path point to a,
// to the one nearest b), or { ok: false, reason, detail } with reason:
//   'no-key'   no key entered
//   'bad-key'  the service refused the key
//   'limit'    daily or per-minute limit reached
//   'no-route' no path between (or near) the two points
//   'offline'  the service could not be reached
//   'error'    anything else
export async function routeBetween(a, b, key) {
    if (!key) return { ok: false, reason: 'no-key' };
    const k = cacheKey(a, b);
    if (cache.has(k)) return cache.get(k);

    let response, body = null;
    try {
        response = await fetch(ROUTER.url, {
            method: 'POST',
            headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
            body: JSON.stringify({ coordinates: [[a.lon, a.lat], [b.lon, b.lat]], instructions: false }),
        });
    } catch {
        return { ok: false, reason: 'offline' };
    }
    try {
        body = await response.json();
    } catch {
        // Not JSON: handled by the status below.
    }

    if (response.ok) {
        const coords = body?.features?.[0]?.geometry?.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) return { ok: false, reason: 'no-route', detail: 'empty route' };
        const result = { ok: true, path: coords.map(([lon, lat]) => ({ lat, lon })) };
        cache.set(k, result);
        if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
        return result;
    }

    // Errors look like { error: "text" } or { error: { code: 2010, message: "text" } }.
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message ?? '';
    const code = body?.error?.code;
    if (response.status === 429 || /quota|rate limit/i.test(message)) return { ok: false, reason: 'limit', detail: message };
    if (response.status === 401 || response.status === 403) return { ok: false, reason: 'bad-key', detail: message };
    // 2004: too far apart for the service, 2009: no route, 2010: no path near a point.
    if (response.status === 404 || [2004, 2009, 2010].includes(code)) return { ok: false, reason: 'no-route', detail: message };
    return { ok: false, reason: 'error', detail: `HTTP ${response.status} ${message}`.trim() };
}
