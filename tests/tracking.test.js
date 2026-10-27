import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTrack } from '../geo.js';
import { buildProfile, profileAt } from '../elevation.js';
import { PositionSmoother, MotionTracker } from '../tracker.js';

const M = 1 / 111195; // degrees of latitude per metre

// Track 1 km north with the given elevations at evenly spaced points.
function trackWithElevations(eles) {
    const n = eles.length - 1;
    return buildTrack(eles.map((ele, i) => ({ lat: 40 + (1000 * i / n) * M, lon: 18, ele })));
}

test('profile: hysteresis ignores bumps below the threshold', () => {
    const track = trackWithElevations([100, 103, 101, 104, 102, 100]);
    const p = buildProfile(track, 5);
    assert.equal(p.totalAscent, 0);
    assert.equal(p.totalDescent, 0);
});

test('profile: real climb and descent are counted', () => {
    const track = trackWithElevations([100, 120, 150, 140, 110]);
    const p = buildProfile(track, 5);
    assert.ok(Math.abs(p.totalAscent - 50) < 1e-6);
    assert.ok(Math.abs(p.totalDescent - 40) < 1e-6);
    // Halfway (500 m) is the summit at 150 m: all ascent done, no descent yet.
    const half = profileAt(track, p, 500);
    assert.ok(Math.abs(half.ele - 150) < 0.01, `ele ${half.ele}`);
    assert.ok(Math.abs(half.ascentDone - 50) < 0.01, `ascent ${half.ascentDone}`);
    assert.ok(half.descentDone < 0.01);
});

test('profile: missing elevations are interpolated; none at all gives null', () => {
    const track = trackWithElevations([100, null, 200]);
    assert.ok(Math.abs(buildProfile(track, 5).eles[1] - 150) < 1e-6);
    assert.equal(buildProfile(trackWithElevations([null, null]), 5), null);
});

test('smoother: discards inaccurate fixes and weights by accuracy', () => {
    const s = new PositionSmoother({ maxAccuracyM: 30, windowSize: 5 });
    assert.equal(s.add({ lat: 40, lon: 18, acc: 31, time: 0 }), null);
    s.add({ lat: 40, lon: 18, acc: 5, time: 1000 });
    const out = s.add({ lat: 40 + 30 * M, lon: 18, acc: 10, time: 2000 });
    // Weights 1/25 and 1/100: the result is 1/5 of the way to the worse fix (6 m).
    assert.ok(Math.abs((out.lat - 40) / M - 6) < 0.01, `${(out.lat - 40) / M}`);
    assert.equal(out.count, 2);
});

test('smoother: keeps only the last N fixes', () => {
    const s = new PositionSmoother({ maxAccuracyM: 30, windowSize: 3 });
    for (let i = 0; i < 10; i++) s.add({ lat: 40 + i * M, lon: 18, acc: 5, time: i * 1000 });
    const out = s.add({ lat: 40 + 10 * M, lon: 18, acc: 5, time: 10_000 });
    assert.equal(out.count, 3);
    assert.ok(Math.abs((out.lat - 40) / M - 9) < 0.01); // mean of 8, 9, 10
});

test('motion: walking, stopping (jitter undone), resuming', () => {
    const t = new MotionTracker({ stopRadiusM: 15, stopTimeS: 30 });
    t.start(0);
    // Walk north 1 m/s for 60 s.
    for (let s = 1; s <= 60; s++) t.update({ lat: 40 + s * M, lon: 18 }, 5, s * 1000);
    assert.ok(Math.abs(t.walked - 59) < 0.5, `walked ${t.walked}`);
    // Stand still with ±4 m jitter for 40 s.
    const jitter = [4, -3, 2, -4, 3, -2, 4, -4, 1, -3];
    let changed = null;
    for (let s = 61; s <= 100; s++) {
        const r = t.update({ lat: 40 + (60 + jitter[s % 10]) * M, lon: 18 }, 5, s * 1000);
        if (r) changed = { r, s };
    }
    assert.deepEqual(changed?.r, 'stopped');
    assert.equal(t.state, 'STOPPED');
    // Jitter while standing must not add distance.
    assert.ok(Math.abs(t.walked - 59) < 3, `walked ${t.walked}`);
    assert.ok(t.stoppedMs >= 30_000, `stopped ${t.stoppedMs}`);
    // Walk away: resumes once outside 15 m, counting from that point.
    let resumedAt = null;
    for (let s = 101; s <= 140; s++) {
        if (t.update({ lat: 40 + (60 + (s - 100)) * M, lon: 18 }, 5, s * 1000) === 'resumed') resumedAt = s;
    }
    // The stop centre includes a few approach positions, so it sits a little behind where we stood.
    assert.ok(resumedAt != null && resumedAt - 100 >= 12 && resumedAt - 100 <= 18, `resumed at ${resumedAt}`);
    assert.equal(t.state, 'MOVING');
    // Walked to 100 m in total: nothing lost or added by the stop.
    assert.ok(Math.abs(t.walked - 99) < 5, `walked ${t.walked}`);
    assert.equal(t.movingMs + t.stoppedMs, 140_000);
});

test('motion: slow walking (0.7 m/s, steep climb pace) is not mistaken for a stop', () => {
    const t = new MotionTracker({ stopRadiusM: 15, stopTimeS: 30 });
    t.start(0);
    // 21 m covered in any 30 s window, more than the 15 m limit.
    for (let s = 1; s <= 120; s++) {
        assert.equal(t.update({ lat: 40 + 0.7 * s * M, lon: 18 }, 5, s * 1000), null);
    }
});

// 1.2 km/h horizontal = 0.333 m/s: only 10 m covered in 30 s, inside the 15 m limit.
// On a 40% slope that is 4 m of climbing per 30 s (480 m/h, a steep-climb pace).
function steepClimb(t, withElevation) {
    const speed = 1.2 / 3.6, grade = 0.4;
    const changes = [];
    t.start(0);
    for (let s = 1; s <= 180; s++) {
        const x = speed * s;
        const r = t.update({ lat: 40 + x * M, lon: 18 }, 5, s * 1000, withElevation ? 500 + grade * x : null);
        if (r) changes.push(r);
    }
    return changes;
}

test('motion: steep slow climb (1.2 km/h on a 40% slope) is not a stop', () => {
    const t = new MotionTracker({ stopRadiusM: 15, stopTimeS: 30, stopClimbM: 3 });
    assert.deepEqual(steepClimb(t, true), []);
    assert.equal(t.state, 'MOVING');
    assert.ok(t.walked > 55 && t.walked < 65, `walked ${t.walked}`);
    assert.equal(t.stoppedMs, 0);
});

test('motion: without track elevations the same climb would count as a stop', () => {
    const t = new MotionTracker({ stopRadiusM: 15, stopTimeS: 30, stopClimbM: 3 });
    assert.ok(steepClimb(t, false).includes('stopped'));
});

test('motion: standing still on a steep slope is still a stop', () => {
    const t = new MotionTracker({ stopRadiusM: 15, stopTimeS: 30, stopClimbM: 3 });
    t.start(0);
    // Smoothed jitter of ±2 m along a 40% slope moves the snapped elevation by ±0.8 m.
    const jitter = [2, -1, 1, -2, 0, 2, -2, 1, -1, 0];
    let changed = null;
    for (let s = 1; s <= 40; s++) {
        const x = jitter[s % 10];
        changed = t.update({ lat: 40 + x * M, lon: 18 }, 5, s * 1000, 500 + 0.4 * x) || changed;
    }
    assert.equal(changed, 'stopped');
});

test('motion: snapshot and restore keep distance and clocks, paused', () => {
    const t = new MotionTracker({ stopRadiusM: 15, stopTimeS: 30 });
    t.start(0);
    for (let s = 1; s <= 20; s++) t.update({ lat: 40 + s * M, lon: 18 }, 5, s * 1000);
    const saved = JSON.parse(JSON.stringify(t.snapshot()));

    const u = new MotionTracker({ stopRadiusM: 15, stopTimeS: 30 });
    u.restore(saved);
    assert.equal(u.walked, t.walked);
    assert.equal(u.movingMs, 20_000);
    assert.equal(u.lastTick, null); // paused until Start
    // Continuing after a restart: the first new fix starts a new leg, no jump added.
    u.start(100_000);
    u.update({ lat: 41, lon: 18 }, 5, 101_000);
    assert.equal(u.walked, t.walked);
});
