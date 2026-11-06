// Place search (Explore, and later From -> To). Only this file talks to the
// geocoding service (through the Trails relay); GEOCODER in map-config.js names
// it, so another service can replace it there. Never throws: every failure
// comes back as a reason.

import { GEOCODER } from './map-config.js';

export const GEOCODER_ATTRIBUTION = GEOCODER.attribution;
export const searchAvailable = () => Boolean(GEOCODER.relayUrl);

// Pelias layers, in words.
const KINDS = {
    venue: 'place', address: 'address', street: 'street', neighbourhood: 'neighbourhood',
    borough: 'district', localadmin: 'municipality', locality: 'town', county: 'county',
    macrocounty: 'county', region: 'region', macroregion: 'region', country: 'country',
    postalcode: 'postcode', coarse: 'area',
};

// Places matching text, nearest to near ({ lat, lon }) first when given.
// Resolves { ok: true, places: [{ label, kind, lat, lon, bbox }] } (bbox:
// [west, south, east, north] or null), or { ok: false, reason, detail } with
// reason 'limit' (daily or per-minute limit reached) or 'unavailable'
// (relay not set up, unreachable (offline?) or any other problem).
export async function searchPlaces(text, near = null) {
    if (!GEOCODER.relayUrl) return { ok: false, reason: 'unavailable', detail: 'no relay configured' };
    let response, body = null;
    try {
        response = await fetch(GEOCODER.relayUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, ...(near ? { focus: [near.lon, near.lat] } : {}) }),
        });
    } catch {
        return { ok: false, reason: 'unavailable', detail: 'relay not reachable' };
    }
    try {
        body = await response.json();
    } catch {
        // Not JSON: handled by the status below.
    }
    if (response.ok && Array.isArray(body?.features)) {
        const places = body.features
            .filter((f) => Array.isArray(f?.geometry?.coordinates))
            .map((f) => {
                const [lon, lat] = f.geometry.coordinates;
                const p = f.properties ?? {};
                return {
                    label: p.label || p.name || 'Unnamed place',
                    kind: KINDS[p.layer] ?? p.layer ?? '',
                    lat,
                    lon,
                    bbox: Array.isArray(f.bbox) && f.bbox.length === 4 ? f.bbox : null,
                };
            });
        return { ok: true, places };
    }
    const message = typeof body?.error === 'string' ? body.error : body?.error?.message ?? '';
    if (response.status === 429) return { ok: false, reason: 'limit', detail: message };
    return { ok: false, reason: 'unavailable', detail: `HTTP ${response.status} ${message}`.trim() };
}
