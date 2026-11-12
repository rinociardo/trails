import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    gapPlan, routeOptions, straightOption, splitGapTime, paceBefore, gapNumbers, gapTotals,
    gapPathPoints, splitGaps, replaceGapPoints, trackSlice, pathLength, GAP_SHORT_M, DEFAULT_PACE_MPS,
} from '../gaps.js';
import { buildTrack, haversine } from '../geo.js';
import { MotionTracker, PathRecorder, MAX_TICK_MS } from '../tracker.js';

// Points along a line north from 46° N, 8° E, every `step` metres.
const north = (m) => ({ lat: 46 + m / 111_195, lon: 8 });
const east = (p, m) => ({ lat: p.lat, lon: p.lon + m / (111_195 * Math.cos(p.lat * Math.PI / 180)) });
const MIN = 60_000;

test('gaps: a short gap is a straight line, no request', () => {
    const plan = gapPlan({ from: north(0), to: north(30), durationMs: 5 * MIN });
    assert.equal(plan.kind, 'short');
    assert.ok(GAP_SHORT_M === 50);
});

test('gaps: on the track before and after, the track fills it', () => {
    const track = buildTrack([north(0), north(200), east(north(200), 300), east(north(500), 300)]);
    const from = north(100), to = east(north(350), 300);
    const plan = gapPlan({ from, to, durationMs: 10 * MIN, track, alongBefore: 100, alongAfter: 200 + 300 + 150 });
    assert.equal(plan.kind, 'track');
    // 100 m north, 300 m east, 150 m north: 550 m, not the 380 m straight line.
    assert.ok(Math.abs(plan.option.distance - 550) < 2, plan.option.distance);
    // Walking backwards along the track works too.
    const back = trackSlice(track, 650, 100);
    assert.ok(Math.abs(pathLength(back) - 550) < 2);
    assert.ok(haversine(back[0], east(north(350), 300)) < 1);
});

test('gaps: the track is not used if it would mean walking too fast', () => {
    const track = buildTrack([north(0), north(5000)]);
    const plan = gapPlan({ from: north(0), to: north(4000), durationMs: 5 * MIN, track, alongBefore: 0, alongAfter: 4000 });
    assert.equal(plan.kind, 'route'); // 4 km in 5 min is 48 km/h
});

test('gaps: otherwise ask the router; very far apart is a straight guess', () => {
    assert.equal(gapPlan({ from: north(0), to: north(800), durationMs: 10 * MIN }).kind, 'route');
    assert.equal(gapPlan({ from: north(0), to: north(80_000), durationMs: 600 * MIN }).kind, 'far');
});

test('gaps: alternatives that are too fast or too long are dropped; the default fits your pace', () => {
    const from = north(0), to = north(1000);
    const direct = [north(200), north(600)];                        // ≈1000 m
    const bend = [east(north(300), 300), east(north(700), 300)];    // ≈1600 m
    const huge = [east(north(500), 2000)];                          // ≈4100 m: over 3× the straight line
    const durationMs = 15 * MIN;
    // Pace 1.8 m/s: 1600 m in 15 min (1.78 m/s) fits better than 1000 m (1.1 m/s).
    const { options, chosen } = routeOptions([direct, bend, huge], { from, to, durationMs, paceMps: 1.8 });
    assert.equal(options.length, 2);
    assert.equal(chosen, 1);
    // A short gap time: the 1600 m route would be 9.6 km/h, over the default 7 km/h.
    const fast = routeOptions([direct, bend], { from, to, durationMs: 10 * MIN, paceMps: 1.8 });
    assert.equal(fast.options.length, 1);
    assert.ok(Math.abs(fast.options[0].distance - 1000) < 2);
    // Joined to the gap's two ends.
    assert.deepEqual(fast.options[0].points[0], from);
    assert.deepEqual(fast.options[0].points.at(-1), to);
    // Nothing walkable: no options (the app then draws it straight, as a guess).
    assert.equal(routeOptions([huge], { from, to, durationMs, paceMps: 1.2 }).options.length, 0);
});

test('gaps: time is moving for as long as the distance takes at your pace, the rest stopped', () => {
    assert.deepEqual(splitGapTime(600, 10 * MIN, 1.2), { movingMs: 500_000, stoppedMs: 100_000 });
    assert.deepEqual(splitGapTime(2000, 10 * MIN, 1.2), { movingMs: 600_000, stoppedMs: 0 });
    assert.deepEqual(splitGapTime(0, 10 * MIN, 1.2), { movingMs: 0, stoppedMs: 600_000 });
    assert.equal(paceBefore({ walked: 100, movingMs: 30_000 }), DEFAULT_PACE_MPS); // under a minute
    assert.equal(paceBefore({ walked: 3000, movingMs: 50 * MIN }), 1);
    assert.equal(paceBefore({ walked: 30_000, movingMs: 50 * MIN }), 7 / 3.6);       // capped
});

test('gaps: numbers of the chosen option, and switching changes the totals', () => {
    const from = { ...north(0), time: 0, ele: 1000 }, to = { ...north(1000), time: 15 * MIN, ele: 1100 };
    const flat = { source: 'route', points: [from, { ...north(500), ele: 1050 }, to], distance: 1000 };
    const longer = { source: 'route', points: [from, { ...east(north(500), 600), ele: 1200 }, to], distance: 1562 };
    const gap = { id: 'g', from, to, gapMs: 15 * MIN, durationMs: 15 * MIN, paceMps: 1.25, chosen: 0, options: [flat, longer] };
    const a = gapNumbers(gap, 5);
    assert.equal(a.distance, 1000);
    assert.equal(a.movingMs, 800_000);
    assert.equal(a.ascent, 100);
    assert.equal(a.descent, 0);
    gap.chosen = 1;
    const b = gapNumbers(gap, 5);
    assert.equal(b.ascent, 200);
    assert.equal(b.descent, 100);
    assert.equal(gapTotals([gap, { ...gap, chosen: 0 }], 5).walked, 2562);
});

test('gaps: recorded path gets the filled points between the two fixes, and they can be swapped', () => {
    const from = { ...north(0), time: 1000 }, to = { ...north(300), time: 301_000 };
    const gap = {
        id: 'g1', from, to, gapMs: 300_000, durationMs: 300_000, paceMps: 1.2, chosen: 0,
        options: [{ source: 'route', points: [from, north(100), north(200), to], distance: 300 }, straightOption(from, to, 300_000)],
    };
    const segments = [[{ ...north(-10), time: 0 }, { ...from }, { ...to, gapBefore: 'g1' }, { ...north(310), time: 302_000 }]];
    assert.ok(replaceGapPoints(segments, 'g1', gapPathPoints(gap)));
    assert.equal(segments[0].length, 6);
    assert.deepEqual(segments[0].slice(2, 4).map((p) => p.time), [101_000, 201_000]); // spread by distance
    assert.ok(segments[0].slice(2, 4).every((p) => p.gap === 'g1'));

    const runs = splitGaps(segments);
    assert.deepEqual(runs.map((r) => [r.gap, r.points.length]), [[null, 2], ['g1', 4], [null, 2]]);

    gap.chosen = 1; // straight: no points in between
    replaceGapPoints(segments, 'g1', gapPathPoints(gap));
    assert.equal(segments[0].length, 4);
    assert.deepEqual(splitGaps(segments).map((r) => [r.gap, r.points.length]), [[null, 2], ['g1', 2], [null, 2]]);
});

test('motion: a suspended app does not tick; a gap rolls the clocks back to the last fix', () => {
    const m = new MotionTracker();
    m.start(0);
    for (let s = 1; s <= 60; s++) m.update(north(s * 1.2), 5, s * 1000);
    assert.equal(m.movingMs, 60_000);
    // Foreground, no fixes for 2 minutes: the clock keeps ticking...
    for (let s = 61; s <= 180; s++) m.tick(s * 1000);
    assert.equal(m.movingMs, 180_000);
    // ...then the gap ends: back to the last fix; the gap accounts for the 2 minutes.
    const walked = m.walked;
    m.gap(181_000, north(500));
    assert.equal(m.movingMs, 60_000);
    m.update(north(500), 5, 181_000);
    assert.equal(m.walked, walked); // the jump is not counted here
    // Suspended (screen locked): one tick after 10 minutes adds nothing.
    m.tick(181_000 + 10 * MIN);
    assert.equal(m.movingMs, 60_000);
    assert.ok(MAX_TICK_MS <= 10_000);
});

test('motion: a gap while stopped, back in the same spot, is all stopped time', () => {
    const m = new MotionTracker();
    m.start(0);
    for (let s = 1; s <= 40; s++) m.update(north(s % 2), 5, s * 1000);
    assert.equal(m.state, 'STOPPED');
    const { movingMs, stoppedMs } = m;
    m.gap(40_000 + 5 * MIN, north(1), { still: true });
    assert.equal(m.state, 'STOPPED');
    assert.equal(m.movingMs, movingMs);
    assert.equal(m.stoppedMs, stoppedMs + 5 * MIN);
});

test('path recorder keeps the gap mark on the first fix after a gap', () => {
    const p = new PathRecorder();
    p.add({ ...north(0), time: 0 });
    p.add({ ...north(1), time: 1, gapBefore: 'g' }, { force: true });
    assert.equal(p.segments[0][1].gapBefore, 'g');
});

test('GPX export marks filled points: what filled them, and no GPS fix', async () => {
    const { buildGpx } = await import('../gpx.js');
    const text = buildGpx({ name: 'Walk', segments: [
        [{ lat: 46, lon: 8, ele: 1000, time: 0 }, { lat: 46.001, lon: 8, ele: 1005, time: 60_000 }],
        [{ lat: 46.001, lon: 8, time: 60_000, type: 'Gap filled with a trail route (a guess)' },
            { lat: 46.002, lon: 8, time: 90_000, type: 'Gap filled with a trail route (a guess)', fix: 'none' },
            { lat: 46.003, lon: 8, time: 120_000, type: 'Gap filled with a trail route (a guess)' }],
    ] });
    assert.match(text, /<time>1970-01-01T00:01:30.000Z<\/time><type>Gap filled with a trail route \(a guess\)<\/type><fix>none<\/fix>/);
    assert.equal((text.match(/<trkseg>/g) || []).length, 2);
});
