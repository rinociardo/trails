// Recorded answers for tests, so no test uses the shared quota of place search and
// routing, or needs a connection. The places are invented (see the fixture).

import { readFileSync } from 'node:fs';

const RECORDED = JSON.parse(readFileSync(new URL('../fixtures/guide-recorded-responses.json', import.meta.url), 'utf8'));
const NOTHING_FOUND = { type: 'FeatureCollection', features: [] };
const NO_ROUTE = { error: { code: 2009, message: 'Route could not be found.' }, from: 'openrouteservice' };
const same = (a, lat, lon) => Math.abs(a[0] - lat) < 1e-6 && Math.abs(a[1] - lon) < 1e-6;

// The relay's answer to a request: { status, body }, or null if it isn't one of the relay's.
function answer(url, requestBody) {
    const { pathname } = new URL(url);
    const body = JSON.parse(requestBody ?? '{}');
    if (pathname === '/geocode') return { status: 200, body: RECORDED.geocode[body.text] ?? NOTHING_FOUND };
    if (pathname === '/route') {
        const [[fromLon, fromLat], [toLon, toLat]] = body.coordinates;
        const leg = RECORDED.routes.find((r) => same(r.from, fromLat, fromLon) && same(r.to, toLat, toLon));
        return leg ? { status: 200, body: leg.response } : { status: 404, body: NO_ROUTE };
    }
    return null;
}

// Node tests: replaces fetch. Anything but the relay's two calls is refused. Returns
// { calls, restore() }; calls lists the URLs and request bodies answered.
export function useRecordedResponses() {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, options = {}) => {
        const reply = answer(String(url), options.body);
        if (!reply) throw new Error(`network is off in tests: ${url}`);
        calls.push(`${url} ${options.body}`);
        return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'Content-Type': 'application/json' } });
    };
    return { calls, restore() { globalThis.fetch = realFetch; } };
}

// Browser test scripts (Playwright): the same answers for a browser context. Run a
// script against the real relay only when that is explicitly asked for.
export async function useRecordedResponsesInBrowser(context) {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST' };
    await context.route(/\/(geocode|route)$/, async (route) => {
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const reply = answer(request.url(), request.postData());
        return route.fulfill({ status: reply.status, headers: cors, contentType: 'application/json', body: JSON.stringify(reply.body) });
    });
}
