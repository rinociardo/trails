// Trails relay: a Cloudflare Worker that holds the openrouteservice key as a
// secret (ORS_KEY), so the app needs no key. It answers only the app's two kinds
// of request: POST /route (one foot-hiking route between two points, or with
// "alternatives": true up to 3 different ones, for filling recording gaps) and
// POST /geocode (a place search), only from the allowed sites (ALLOWED_ORIGINS),
// with a per-visitor rate limit (RATE_LIMITER) shared by both.
// openrouteservice's FAQ recommends exactly this: keep the key on a server that
// calls the API for the app.

const ORS_URL = 'https://api.openrouteservice.org/v2/directions/foot-hiking/geojson';
const GEOCODE_URL = 'https://api.openrouteservice.org/geocode/search';
const MAX_TEXT = 200;      // characters of a place search
const GEOCODE_RESULTS = 8; // a short list
const MAX_BODY_BYTES = 2000;
const MAX_SPAN_DEG = 0.5; // ≈50 km between the two points: planner segments are much shorter

// Two [lon, lat] points, close enough together to be one planner segment.
function validCoordinates(coords) {
    if (!Array.isArray(coords) || coords.length !== 2) return false;
    const ok = coords.every((c) => Array.isArray(c) && c.length === 2 &&
        Number.isFinite(c[0]) && Number.isFinite(c[1]) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90);
    return ok && Math.abs(coords[0][0] - coords[1][0]) <= MAX_SPAN_DEG && Math.abs(coords[0][1] - coords[1][1]) <= MAX_SPAN_DEG;
}

// Facts about the key that help diagnose it without revealing it.
function keyShape(key) {
    return {
        length: key.length,
        surroundingSpace: key !== key.trim(),
        unusualCharacters: !/^[\x21-\x7e]*$/.test(key.trim()), // anything but plain visible ASCII
    };
}

// openrouteservice errors look like { error: "text" } or { error: { code, message } }.
function orsMessage(text) {
    try {
        const body = JSON.parse(text);
        const e = body?.error ?? body?.message;
        if (typeof e === 'string') return { message: e };
        if (e && typeof e === 'object') return { code: e.code, message: e.message ?? JSON.stringify(e) };
    } catch {
        // not JSON: use the text itself below
    }
    return { message: text.trim().slice(0, 300) };
}

// A place search: { text, focus?: [lon, lat] } (focus ranks nearby places first).
function geocodeQuery(body) {
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > MAX_TEXT) return null;
    const q = new URLSearchParams({ text, size: String(GEOCODE_RESULTS) });
    const f = body.focus;
    if (f !== undefined) {
        if (!Array.isArray(f) || f.length !== 2 || !f.every(Number.isFinite) || Math.abs(f[0]) > 180 || Math.abs(f[1]) > 90) return null;
        q.set('focus.point.lon', String(f[0]));
        q.set('focus.point.lat', String(f[1]));
    }
    return q;
}

export default {
    async fetch(request, env) {
        const origin = request.headers.get('Origin') ?? '';
        const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const cors = allowed.includes(origin) ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : null;
        // Every answer has a body saying who refused and why ("relay" or "openrouteservice").
        const reply = (status, error, from = 'relay') => new Response(JSON.stringify({ error, from }), {
            status,
            headers: { 'Content-Type': 'application/json', ...cors },
        });

        // Browsers send Origin: other websites are refused here. (A script can fake
        // the header; the rate limit and openrouteservice's own daily quota cap that.)
        if (!cors) return reply(403, `origin not allowed: requests must come from ${allowed.join(' or ') || 'an allowed site'}`);
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: 204,
                headers: { ...cors, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' },
            });
        }
        const path = new URL(request.url).pathname;
        if (request.method !== 'POST' || (path !== '/route' && path !== '/geocode')) {
            return reply(404, 'not found: the relay only answers POST /route and POST /geocode');
        }
        const key = (env.ORS_KEY ?? '').trim();
        if (!key) return reply(503, 'relay not configured: the openrouteservice key (secret ORS_KEY) is missing');

        if (env.RATE_LIMITER) {
            const visitor = request.headers.get('CF-Connecting-IP') ?? 'unknown';
            const { success } = await env.RATE_LIMITER.limit({ key: visitor });
            if (!success) return reply(429, 'rate limit: too many routes from this device, try again in a minute');
        }

        const text = await request.text();
        if (text.length > MAX_BODY_BYTES) return reply(413, `request too large: at most ${MAX_BODY_BYTES} bytes`);
        let body = null;
        try {
            body = JSON.parse(text);
        } catch {
            // handled below
        }
        let call;
        if (path === '/geocode') {
            const query = geocodeQuery(body);
            if (!query) return reply(400, `bad request: expected {"text": "a place", "focus": [lon, lat] (optional)}, at most ${MAX_TEXT} characters`);
            call = [`${GEOCODE_URL}?${query}`, { headers: { Authorization: key, Accept: 'application/json, application/geo+json' } }];
        } else {
            const coordinates = body?.coordinates;
            if (!validCoordinates(coordinates)) {
                return reply(400, 'bad request: expected {"coordinates": [[lon, lat], [lon, lat]], "alternatives": true (optional)}, two points at most 0.5° apart');
            }
            if (body.alternatives !== undefined && typeof body.alternatives !== 'boolean') {
                return reply(400, 'bad request: "alternatives" must be true or false');
            }
            // Up to 3 routes, each sharing at most 60% with the best and at most 60% longer.
            const alternatives = body.alternatives ? { alternative_routes: { target_count: 3, share_factor: 0.6, weight_factor: 1.6 } } : {};
            call = [ORS_URL, {
                method: 'POST',
                headers: { Authorization: key, 'Content-Type': 'application/json', Accept: 'application/json, application/geo+json' },
                body: JSON.stringify({ coordinates, instructions: false, ...alternatives }),
            }];
        }

        let upstream;
        try {
            upstream = await fetch(...call);
        } catch (err) {
            console.log('openrouteservice unreachable:', String(err?.message ?? err).replaceAll(key, '[key]'), 'key:', keyShape(env.ORS_KEY));
            return reply(502, 'openrouteservice unreachable from the relay');
        }
        if (upstream.ok) {
            return new Response(upstream.body, {
                status: upstream.status,
                headers: { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/json', ...cors },
            });
        }

        // An error: pass openrouteservice's own message on (never the key), and log
        // what came back so `wrangler tail` shows the cause.
        const answer = (await upstream.text()).replaceAll(key, '[key]');
        const { code, message } = orsMessage(answer);
        console.log('openrouteservice error', JSON.stringify({
            path,
            status: upstream.status,
            contentType: upstream.headers.get('Content-Type'),
            server: upstream.headers.get('Server'),
            bodyLength: answer.length,
            body: answer.slice(0, 500),
            key: keyShape(env.ORS_KEY),
        }));
        const error = { code, message: message || `openrouteservice answered HTTP ${upstream.status} with no message` };
        // Quota used up (sometimes 403) is a limit for the app; a refused key is the relay's problem.
        if ((upstream.status === 401 || upstream.status === 403) && /quota|limit/i.test(message)) return reply(429, error, 'openrouteservice');
        if (upstream.status === 401 || upstream.status === 403) return reply(502, error, 'openrouteservice');
        return reply(upstream.status, error, 'openrouteservice');
    },
};
