import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClimbCounter, WalkRates, OffTrackDetector, averageRates, walkSnapshot, restoreWalk, nextAlertMode, LEVEL_MPS } from '../walk.js';
import { buildProfile } from '../elevation.js';
import { buildTrack } from '../geo.js';
import { makeUnits } from '../units.js';

test('climb counter: same 5 m hysteresis as a track profile', () => {
    const eles = [100, 102, 99, 101, 107, 112, 110, 104, 103, 98, 120];
    const counter = new ClimbCounter(5);
    for (const e of eles) counter.add(e);
    // The same elevations as a track (points 10 m apart) give the same totals.
    const points = eles.map((ele, i) => ({ lat: 45 + i * 0.00009, lon: 7, ele }));
    const profile = buildProfile(buildTrack(points), 5);
    assert.equal(counter.ascent, profile.totalAscent);
    assert.equal(counter.descent, profile.totalDescent);
    assert.equal(counter.ascent, 12 + 22);
    assert.equal(counter.descent, 14);
});

test('climb counter: small ups and downs do not count, missing elevations are skipped', () => {
    const counter = new ClimbCounter(5);
    for (const e of [500, 503, 498, null, 501, 497, 502, undefined, 499]) counter.add(e);
    assert.equal(counter.ascent, 0);
    assert.equal(counter.descent, 0);
});

test('climb counter: after a pause the gap is not counted as a climb', () => {
    const counter = new ClimbCounter(5);
    counter.add(100);
    counter.add(110);
    counter.pause();       // Stop, drive up the valley, Start
    counter.add(400);
    counter.add(406);
    assert.equal(counter.ascent, 16);
});

test('walk rates: current speed over the last 15 s', () => {
    const rates = new WalkRates();
    for (let s = 0; s <= 60; s++) rates.add({ time: s * 1000, walked: s * 1.2, ele: 100 });
    assert.ok(Math.abs(rates.speed(60_000) - 1.2) < 1e-9);
    assert.equal(new WalkRates().speed(0), null);
});

test('walk rates: vertical speed from the last minute, up and down', () => {
    const climbRate = 400 / 3600; // 400 m an hour
    const up = new WalkRates();
    for (let s = 0; s <= 90; s++) up.add({ time: s * 1000, walked: s, ele: 1000 + s * climbRate + (s % 2 ? 0.3 : -0.3) });
    assert.ok(Math.abs(up.vertical(90_000) * 3600 - 400) < 5, `${up.vertical(90_000) * 3600} m/h`);

    const down = new WalkRates();
    for (let s = 0; s <= 90; s++) down.add({ time: s * 1000, walked: s, ele: 1000 - s * climbRate });
    assert.ok(Math.abs(down.vertical(90_000) * 3600 + 400) < 1);

    // Under 20 s of elevations: no figure yet.
    const early = new WalkRates();
    for (let s = 0; s <= 10; s++) early.add({ time: s * 1000, walked: s, ele: 1000 + s });
    assert.equal(early.vertical(10_000), null);
});

test('walk rates: time climbing and descending, for the average rates', () => {
    const counter = new ClimbCounter(5);
    const rates = new WalkRates();
    const at = (s) => (s <= 600 ? 1000 + s * 0.1 : s <= 900 ? 1060 : 1060 - (s - 900) * 0.2);
    for (let s = 0; s <= 1200; s++) {
        const ele = at(s);
        counter.add(ele);
        rates.add({ time: s * 1000, walked: s * 1.2, ele });
    }
    // 10 min climbing at 360 m/h, 5 min level, 5 min descending at 720 m/h.
    const avg = averageRates(counter, rates);
    assert.ok(Math.abs(avg.up * 3600 - 360) < 40, `up ${avg.up * 3600}`);
    assert.ok(Math.abs(avg.down * 3600 - 720) < 80, `down ${avg.down * 3600}`);
    // The level part counts as neither.
    assert.ok(rates.upMs < 640_000 && rates.downMs < 330_000);
});

test('walk rates: level ground is level, a gap between fixes adds little time', () => {
    const rates = new WalkRates();
    for (let s = 0; s <= 120; s++) rates.add({ time: s * 1000, walked: s, ele: 300 + (s % 3) * 0.1 });
    assert.ok(Math.abs(rates.vertical(120_000)) <= LEVEL_MPS);
    assert.equal(rates.upMs + rates.downMs, 0);
    const counter = new ClimbCounter();
    assert.deepEqual(averageRates(counter, rates), { up: null, down: null });
});

test('walk snapshot survives a force-close', () => {
    const counter = new ClimbCounter(5), rates = new WalkRates();
    counter.ascent = 312; counter.descent = 120; rates.upMs = 900_000; rates.downMs = 300_000;
    const saved = JSON.parse(JSON.stringify(walkSnapshot(counter, rates)));
    const c2 = new ClimbCounter(5), r2 = new WalkRates();
    restoreWalk(c2, r2, saved);
    assert.deepEqual(walkSnapshot(c2, r2), saved);
    assert.equal(c2.anchor, null);
    // A recording saved before v0.12.0 has none: zeros.
    restoreWalk(c2, r2, undefined);
    assert.deepEqual(walkSnapshot(c2, r2), { ascent: 0, descent: 0, upMs: 0, downMs: 0 });
});

test('off track: two far fixes in a row, back inside 80% of the limit', () => {
    const d = new OffTrackDetector({ confirmFixes: 2, backRatio: 0.8 });
    assert.equal(d.update(60, 50), null);   // one jump is not enough
    assert.equal(d.update(30, 50), null);
    assert.equal(d.update(60, 50), null);
    assert.equal(d.update(70, 50), 'off');
    assert.equal(d.offTrack, true);
    assert.equal(d.update(45, 50), null);   // inside the limit but not inside 40 m: still off
    assert.equal(d.offTrack, true);
    assert.equal(d.update(39, 50), 'back');
    assert.equal(d.offTrack, false);
});

test('off track: the wider limit on straight segments', () => {
    const d = new OffTrackDetector();
    assert.equal(d.update(90, 100), null);
    assert.equal(d.update(90, 100), null);
    assert.equal(d.offTrack, false);
    assert.equal(d.update(90, 50), null);
    assert.equal(d.update(90, 50), 'off');
});

test('alert modes cycle off → banner → sound', () => {
    assert.equal(nextAlertMode('off'), 'banner');
    assert.equal(nextAlertMode('banner'), 'sound');
    assert.equal(nextAlertMode('sound'), 'off');
});

test('vertical speed per hour, minute or second, in m or ft', () => {
    const v = 420 / 3600;
    const m = makeUnits('metric'), ft = makeUnits('imperial');
    assert.equal(m.verticalSpeed(v), '420 m/h');
    assert.equal(m.verticalSpeed(v, 'min'), '7.0 m/min');
    assert.equal(m.verticalSpeed(v, 's'), '0.12 m/s');
    assert.equal(m.verticalSpeed(-v), '420 m/h');
    assert.equal(ft.verticalSpeed(v), '1,378 ft/h');
    assert.equal(ft.verticalSpeed(v, 'min'), '23.0 ft/min');
    assert.equal(m.verticalSpeed(null), '–');
});
