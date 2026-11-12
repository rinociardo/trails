import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../relay/worker.js';

const SITE = 'https://rinociardo.github.io';
const env = { ORS_KEY: 'secret-key', ALLOWED_ORIGINS: `${SITE},http://localhost:8000` };
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const route = (body, origin = SITE, extra = {}) => new Request('https://trails-relay.example.workers.dev/route', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', ...extra },
    body: typeof body === 'string' ? body : JSON.stringify(body),
});
const TWO_POINTS = { coordinates: [[7.9, 46.59], [7.91, 46.6]] };

// Fake openrouteservice: records what it was sent, answers with status/body.
function fakeOrs(status, body) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init });
        return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    };
    return calls;
}

test('relay: forwards a route request with the secret key, answers with CORS for the site', async () => {
    const calls = fakeOrs(200, { type: 'FeatureCollection', features: [] });
    const res = await worker.fetch(route(TWO_POINTS), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), SITE);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /foot-hiking/);
    assert.equal(calls[0].init.headers.Authorization, 'secret-key');
    assert.deepEqual(JSON.parse(calls[0].init.body).coordinates, TWO_POINTS.coordinates);
    assert.doesNotMatch(await res.text(), /secret-key/);
});

test('relay: alternative routes only when asked (recording gaps), at most 3', async () => {
    const calls = fakeOrs(200, { type: 'FeatureCollection', features: [] });
    await worker.fetch(route(TWO_POINTS), env);
    await worker.fetch(route({ ...TWO_POINTS, alternatives: true }), env);
    await worker.fetch(route({ ...TWO_POINTS, alternatives: false }), env);
    const sent = calls.map((c) => JSON.parse(c.init.body));
    assert.equal(sent[0].alternative_routes, undefined);
    assert.deepEqual(sent[1].alternative_routes, { target_count: 3, share_factor: 0.6, weight_factor: 1.6 });
    assert.equal(sent[2].alternative_routes, undefined);
    assert.equal((await worker.fetch(route({ ...TWO_POINTS, alternatives: 7 }), env)).status, 400);
    assert.equal(calls.length, 3);
});

test('relay: refuses other sites, other paths and bad requests without calling openrouteservice', async () => {
    const calls = fakeOrs(200, {});
    assert.equal((await worker.fetch(route(TWO_POINTS, 'https://evil.example'), env)).status, 403);
    assert.equal((await worker.fetch(route(TWO_POINTS, ''), env)).status, 403);
    const get = new Request('https://x.workers.dev/route', { headers: { Origin: SITE } });
    assert.equal((await worker.fetch(get, env)).status, 404);
    assert.equal((await worker.fetch(route({ coordinates: [[7.9, 46.59]] }), env)).status, 400);
    assert.equal((await worker.fetch(route({ coordinates: [[7.9, 46.59], [9.5, 46.6]] }), env)).status, 400); // 120 km apart
    assert.equal((await worker.fetch(route('not json'), env)).status, 400);
    assert.equal((await worker.fetch(route('x'.repeat(3000)), env)).status, 413);
    assert.equal((await worker.fetch(route(TWO_POINTS), { ...env, ORS_KEY: '' })).status, 503);
    assert.equal(calls.length, 0);
});

test('relay: preflight for the site', async () => {
    const res = await worker.fetch(new Request('https://x.workers.dev/route', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8000' } }), env);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:8000');
    assert.match(res.headers.get('Access-Control-Allow-Methods'), /POST/);
});

test('relay: rate limit per visitor', async () => {
    const calls = fakeOrs(200, {});
    let n = 0;
    const limited = { ...env, RATE_LIMITER: { limit: async ({ key }) => ({ success: key === '1.2.3.4' && ++n <= 2 }) } };
    const ip = { 'CF-Connecting-IP': '1.2.3.4' };
    assert.equal((await worker.fetch(route(TWO_POINTS, SITE, ip), limited)).status, 200);
    assert.equal((await worker.fetch(route(TWO_POINTS, SITE, ip), limited)).status, 200);
    assert.equal((await worker.fetch(route(TWO_POINTS, SITE, ip), limited)).status, 429);
    assert.equal(calls.length, 2);
});

// Captures console.log while fn runs (the relay logs upstream errors for `wrangler tail`).
async function logged(fn) {
    const lines = [], real = console.log;
    console.log = (...args) => lines.push(args.map(String).join(' '));
    try { return { result: await fn(), lines }; } finally { console.log = real; }
}

test('relay: every error has a body; openrouteservice messages are passed on', async () => {
    const own = await worker.fetch(route('not json'), env);
    assert.equal(own.status, 400);
    assert.deepEqual(Object.keys(await own.json()), ['error', 'from']);

    fakeOrs(404, { error: { code: 2010, message: 'Could not find routable point within a radius of 350.0 meters' } });
    let res = await worker.fetch(route(TWO_POINTS), env);
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: { code: 2010, message: 'Could not find routable point within a radius of 350.0 meters' }, from: 'openrouteservice' });

    fakeOrs(400, '');
    const { result, lines } = await logged(() => worker.fetch(route(TWO_POINTS), env));
    assert.equal(result.status, 400);
    assert.match((await result.json()).error.message, /HTTP 400 with no message/);
    assert.match(lines.join('\n'), /"status":400/);

    fakeOrs(429, { error: 'Rate limit exceeded' });
    res = await worker.fetch(route(TWO_POINTS), env);
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error.message, 'Rate limit exceeded');
    fakeOrs(403, { error: 'Quota exceeded' });
    assert.equal((await worker.fetch(route(TWO_POINTS), env)).status, 429);
    fakeOrs(403, { error: 'Access to this API has been disallowed' });
    res = await worker.fetch(route(TWO_POINTS), env);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error.message, 'Access to this API has been disallowed');
    globalThis.fetch = async () => { throw new TypeError('network'); };
    res = await worker.fetch(route(TWO_POINTS), env);
    assert.equal(res.status, 502);
    assert.match((await res.json()).error, /unreachable/);
});

test('relay: the key never appears in answers or logs, and stray spaces around it are ignored', async () => {
    const calls = fakeOrs(400, { error: 'Invalid header secret-key' }); // an answer quoting the key
    const { result, lines } = await logged(() => worker.fetch(route(TWO_POINTS), { ...env, ORS_KEY: ' secret-key\n' }));
    assert.equal(calls[0].init.headers.Authorization, 'secret-key');
    const text = await result.text();
    assert.doesNotMatch(text + lines.join('\n'), /secret-key/);
    assert.match(text, /\[key\]/);
    assert.match(lines.join('\n'), /"surroundingSpace":true/);
});

const search = (body, origin = SITE) => new Request('https://trails-relay.example.workers.dev/geocode', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
});

test('relay: place search goes to openrouteservice geocoding with the key, near the focus point', async () => {
    const calls = fakeOrs(200, { type: 'FeatureCollection', features: [{ properties: { label: 'Wengen, BE, Switzerland' } }] });
    const res = await worker.fetch(search({ text: 'Wengen', focus: [7.9, 46.6] }), env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('Access-Control-Allow-Origin'), SITE);
    const url = new URL(calls[0].url);
    assert.equal(url.origin + url.pathname, 'https://api.openrouteservice.org/geocode/search');
    assert.equal(url.searchParams.get('text'), 'Wengen');
    assert.equal(url.searchParams.get('size'), '8');
    assert.equal(url.searchParams.get('focus.point.lat'), '46.6');
    assert.equal(calls[0].init.headers.Authorization, 'secret-key');
    assert.doesNotMatch(calls[0].url, /secret-key/);
    assert.equal((await res.json()).features[0].properties.label, 'Wengen, BE, Switzerland');
});

test('relay: only routing and place search are relayed', async () => {
    const calls = fakeOrs(200, {});
    assert.equal((await worker.fetch(search({ text: '' }), env)).status, 400);
    assert.equal((await worker.fetch(search({ text: 'x'.repeat(201) }), env)).status, 400);
    assert.equal((await worker.fetch(search({ text: 'Wengen', focus: [7.9] }), env)).status, 400);
    for (const path of ['/geocode/reverse', '/v2/directions/foot-hiking', '/isochrones', '/']) {
        const req = new Request(`https://x.workers.dev${path}`, { method: 'POST', headers: { Origin: SITE }, body: '{"text":"a"}' });
        const res = await worker.fetch(req, env);
        assert.equal(res.status, 404, path);
        assert.match((await res.json()).error, /POST \/route and POST \/geocode/);
    }
    assert.equal(calls.length, 0);
});
