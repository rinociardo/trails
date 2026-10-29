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
