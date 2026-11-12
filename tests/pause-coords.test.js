import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PauseWatcher, judgeExit, walkedUnseenMs, DEFAULT_PAUSE_RADIUS_M } from '../pause.js';
import { parseCoordinates, formatCoordinates } from '../coords.js';
import { haversine } from '../geo.js';

// ---------- Smart Pause: simulated picnics ----------

const CENTRE = { lat: 46, lon: 8 };
const M_LAT = 1 / 111_195;
const M_LON = 1 / (111_195 * Math.cos(46 * Math.PI / 180));
// x metres east, y metres north of the picnic spot.
const at = (x, y, time, extra = {}) => ({ lat: CENTRE.lat + y * M_LAT, lon: CENTRE.lon + x * M_LON, time, ...extra });
const T0 = 1_000_000;

// Feeds positions one a second; returns the first decision that isn't 'none'.
function feed(w, positions) {
    for (const p of positions) {
        const d = w.add(p);
        if (d.action !== 'none') return { ...d, at: p.time };
    }
    return { action: 'none' };
}

test('pause: wandering around the picnic spot never resumes', () => {
    const w = new PauseWatcher({ centre: CENTRE, since: T0 });
    const positions = [];
    for (let s = 1; s <= 1800; s++) {
        // Strolling about, up to 120 m away (inside the 150 m zone), for half an hour.
        const r = 120 * Math.abs(Math.sin(s / 200));
        positions.push(at(r * Math.cos(s / 37), r * Math.sin(s / 37), T0 + s * 1000));
    }
    assert.equal(feed(w, positions).action, 'none');
    assert.equal(DEFAULT_PAUSE_RADIUS_M, 150);
});

test('pause: leaving to carry on the hike resumes after a minute, counted from the exit', () => {
    const w = new PauseWatcher({ centre: CENTRE, since: T0 });
    const positions = [];
    for (let s = 1; s <= 600; s++) positions.push(at(10, 5, T0 + s * 1000));     // 10 min sitting
    for (let s = 1; s <= 200; s++) positions.push(at(0, 1.3 * s, T0 + (600 + s) * 1000)); // walk north at 4.7 km/h
    const d = feed(w, positions);
    assert.equal(d.action, 'resume');
    // The exit: the first position outside 150 m (s = 116, 150.8 m)...
    assert.ok(haversine(d.exit, CENTRE) > 150 && haversine(d.exit, CENTRE) < 152);
    assert.equal(d.exit.time, T0 + 716_000);
    // ...decided about a minute later.
    assert.ok(d.at - d.exit.time >= 60_000 && d.at - d.exit.time <= 61_000);
});

test('pause: walking back to the car resumes too (that is what Undo is for); driving off then does not', () => {
    const w = new PauseWatcher({ centre: CENTRE, since: T0 });
    const walk = [];
    for (let s = 1; s <= 300; s++) walk.push(at(1.2 * s, 0, T0 + s * 1000)); // to the car park, 360 m east
    const d = feed(w, walk);
    assert.equal(d.action, 'resume');
    // The app undoes the resume and turns automatic resuming off for this pause.
    w.autoOff = true;
    w.outside = [];
    const drive = [];
    for (let s = 1; s <= 300; s++) drive.push(at(360 + 15 * s, 0, T0 + (300 + s) * 1000));
    assert.equal(feed(w, drive).action, 'none');
    // Even without Undo, driving is no walk: unclear, so it asks.
    const w2 = new PauseWatcher({ centre: CENTRE, since: T0 });
    const fast = [];
    for (let s = 1; s <= 120; s++) fast.push(at(15 * s, 0, T0 + s * 1000));
    assert.equal(feed(w2, fast).action, 'ask');
});

test('pause: outside the zone but back and forth, or slow: asks once instead of deciding', () => {
    const w = new PauseWatcher({ centre: CENTRE, since: T0 });
    const positions = [];
    // Pacing between 170 m and 230 m from the spot (looking for a signal).
    for (let s = 1; s <= 300; s++) positions.push(at(200 + 30 * Math.sin(s / 10), 0, T0 + s * 1000));
    const first = feed(w, positions.slice(0, 150));
    assert.equal(first.action, 'ask');
    assert.equal(feed(w, positions.slice(150)).action, 'none'); // asked once
    // Back inside, then out again: may ask again.
    w.add(at(0, 0, T0 + 301_000));
    assert.equal(w.asked, false);

    const slow = new PauseWatcher({ centre: CENTRE, since: T0 });
    const crawl = [];
    for (let s = 1; s <= 120; s++) crawl.push(at(160 + 0.2 * s, 0, T0 + s * 1000)); // 0.7 km/h
    assert.equal(feed(slow, crawl).action, 'ask');
});

test('pause: progress along a loaded track counts even when the track bends back past the zone', () => {
    const pts = [];
    // Outside the zone, walking a curve around it: not straight away, but forward on the track.
    // An arc around the spot, 200 m out, at 1.3 m/s.
    for (let s = 0; s <= 70; s++) {
        const a = s * 1.3 / 200;
        pts.push(at(200 * Math.cos(a), 200 * Math.sin(a), T0 + s * 1000, { onTrack: true, along: 1000 + s * 1.3 }));
    }
    assert.equal(judgeExit(pts.map(({ along, onTrack, ...p }) => p), CENTRE), 'unclear');
    assert.equal(judgeExit(pts, CENTRE), 'resume');
});

test('pause: phone locked during the pause, back far away: resume with a filled stretch from the zone edge', () => {
    const w = new PauseWatcher({ centre: CENTRE, since: T0 });
    feed(w, [at(5, 5, T0 + 1000), at(6, 4, T0 + 2000)]);
    // 25 minutes later, 1.2 km north.
    const d = w.add(at(0, 1200, T0 + 2000 + 25 * 60_000));
    assert.equal(d.action, 'jump');
    assert.ok(Math.abs(haversine(d.exit, CENTRE) - 150) < 1);
    // Walking unseen: 1.05 km × 1.3 at 1.2 m/s ≈ 19 min, the rest of the 25 stays paused.
    const ms = walkedUnseenMs(d.exit, at(0, 1200, 0), 1.2, 25 * 60_000);
    assert.ok(ms > 18 * 60_000 && ms < 20 * 60_000, String(ms));
    // Back after a hole but just outside the zone: no jump, watched as usual.
    const w2 = new PauseWatcher({ centre: CENTRE, since: T0 });
    assert.equal(w2.add(at(0, 200, T0 + 10 * 60_000)).action, 'none');
});

test('pause: survives a force-close', () => {
    const w = new PauseWatcher({ centre: CENTRE, since: T0, maxSpeedMps: 2 });
    w.add(at(0, 160, T0 + 1000));
    const copy = PauseWatcher.restore(JSON.parse(JSON.stringify(w.snapshot())));
    assert.deepEqual(copy.snapshot(), w.snapshot());
});

// ---------- Coordinates typed in the search box ----------

test('coordinates: decimal, with letters, degrees-minutes-seconds', () => {
    const near = (p, lat, lon) => assert.ok(p && Math.abs(p.lat - lat) < 1e-4 && Math.abs(p.lon - lon) < 1e-4, JSON.stringify(p));
    near(parseCoordinates('39.5274, -75.8113'), 39.5274, -75.8113);
    near(parseCoordinates('39.5274 -75.8113'), 39.5274, -75.8113);
    near(parseCoordinates('39.5274,-75.8113'), 39.5274, -75.8113);
    near(parseCoordinates('39.5274 N, 75.8113 W'), 39.5274, -75.8113);
    near(parseCoordinates('N39.5274 W75.8113'), 39.5274, -75.8113);
    near(parseCoordinates('39.5274N 75.8113W'), 39.5274, -75.8113);
    near(parseCoordinates('75.8113 W 39.5274 N'), 39.5274, -75.8113); // longitude first, letters say so
    near(parseCoordinates('39°31\'38.6"N 75°48\'40.7"W'), 39.52739, -75.81131);
    near(parseCoordinates('39°31′38.6″N, 75°48′40.7″W'), 39.52739, -75.81131);
    near(parseCoordinates('39 31 38.6 N 75 48 40.7 W'), 39.52739, -75.81131);
    near(parseCoordinates('39°31.643\'N 75°48.678\'W'), 39.52738, -75.8113);
    near(parseCoordinates('S 33°51\'35" E 151°12\'40"'), -33.85972, 151.21111);
});

test('coordinates: decimal commas with a space or semicolon between', () => {
    const near = (p, lat, lon) => assert.ok(p && Math.abs(p.lat - lat) < 1e-6 && Math.abs(p.lon - lon) < 1e-6, JSON.stringify(p));
    near(parseCoordinates('39,5274 18,0312'), 39.5274, 18.0312);
    near(parseCoordinates('39,5274; 18,0312'), 39.5274, 18.0312);
    near(parseCoordinates('39,5274;18,0312'), 39.5274, 18.0312);
    near(parseCoordinates('39,5274, 18,0312'), 39.5274, 18.0312);
    near(parseCoordinates('40,1234 N; 18,5 E'), 40.1234, 18.5);
});

test('coordinates: place names and nonsense are not coordinates', () => {
    for (const text of ['Tre Cime di Lavaredo', 'Monte Cimone', '10 Downing Street', '2026', '', 'Route 66 Trail',
        '91.5, 10', '45, 200', '39°75\'N 75°W', '39 N 40 N', '-39 S 75 W']) {
        assert.equal(parseCoordinates(text), null, text);
    }
});

test('coordinates: shown as decimal and degrees-minutes-seconds', () => {
    assert.deepEqual(formatCoordinates({ lat: 39.527389, lon: -75.811306 }), { decimal: '39.52739, -75.81131', dms: '39°31\'38.6"N 75°48\'40.7"W' });
});
