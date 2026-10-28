import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGpx, gpxFileName, NO_ELEVATION_DESC } from '../gpx.js';
import { PathRecorder, MotionTracker, trimToWindow, elevationRange } from '../tracker.js';

const M = 1 / 111195; // degrees of latitude per metre

test('gpx: elevations, times and segments are written', () => {
    const t = Date.UTC(2026, 9, 27, 8, 0, 0);
    const text = buildGpx({
        name: 'Rifugio & "back" <loop>',
        segments: [
            [{ lat: 46.1, lon: 11.2, ele: 1203.44, time: t }, { lat: 46.1001, lon: 11.2, ele: null, time: t + 5000 }],
            [],
            [{ lat: 46.2, lon: 11.3, ele: 1500 }],
        ],
        time: t,
    });
    assert.match(text, /<name>Rifugio &amp; &quot;back&quot; &lt;loop&gt;<\/name>/);
    assert.match(text, /<trkpt lat="46.1000000" lon="11.2000000"><ele>1203.4<\/ele><time>2026-10-27T08:00:00.000Z<\/time><\/trkpt>/);
    assert.match(text, /lat="46.1001000" lon="11.2000000"><time>2026-10-27T08:00:05.000Z<\/time>/); // no ele
    assert.match(text, /<ele>1500.0<\/ele><\/trkpt>/); // planned track: no time
    assert.equal(text.match(/<trkseg>/g).length, 2); // the empty segment is skipped
});

test('gpx: file names', () => {
    const t = new Date(2026, 9, 27, 12).getTime();
    assert.equal(gpxFileName('Sample loop', t), 'Sample-loop_2026-10-27.gpx');
    assert.equal(gpxFileName('Sentiero / Via ferrata: Brenta?', t), 'Sentiero-Via-ferrata-Brenta_2026-10-27.gpx');
    assert.equal(gpxFileName('Höhenweg Nr.1', t), 'Höhenweg-Nr-1_2026-10-27.gpx');
    assert.equal(gpxFileName('', t), 'track_2026-10-27.gpx');
});

test('path: keeps a point every 5 m and a segment per Start', () => {
    const path = new PathRecorder();
    path.startSegment();
    for (let i = 0; i <= 100; i++) path.add({ lat: 40 + i * M, lon: 18, ele: 100, time: i * 1000 }); // 1 m/s
    assert.equal(path.current().length, 21); // 0, 5, 10 ... 100 m
    path.startSegment();
    path.startSegment(); // still empty: no second new segment
    path.add({ lat: 41, lon: 18, time: 200_000 });
    assert.equal(path.segments.length, 2);
    assert.equal(path.pointCount, 22);
});

test('path: a stop is recorded as its centre, at the start and end of the stop', () => {
    const path = new PathRecorder();
    const motion = new MotionTracker({ stopRadiusM: 15, stopTimeS: 30 });
    path.startSegment();
    motion.start(0);
    let t = 0;
    const feed = (lat, lon) => {
        const pos = { lat, lon };
        const anchor = motion.anchor; // cleared by update() on resume
        const change = motion.update(pos, 5, t, 100);
        if (change === 'stopped') path.stop(motion.anchor, motion.stoppedSince);
        else if (change === 'resumed') path.resume(anchor, t);
        if (motion.state === 'MOVING') path.add({ ...pos, ele: 100, time: t });
        t += 1000;
    };
    for (let i = 0; i < 60; i++) feed(40 + i * 1.4 * M, 18);           // walk 84 m
    const stopLat = 40 + 60 * 1.4 * M;
    for (let i = 0; i < 120; i++) feed(stopLat + (i % 2 ? 4 : -4) * M, 18 + (i % 3) * 3e-5); // jitter ±4 m for 2 min
    assert.equal(motion.state, 'STOPPED');
    for (let i = 1; i < 30; i++) feed(stopLat + i * 1.4 * M, 18);       // walk on

    const seg = path.current();
    const times = seg.map((p) => p.time);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), 'times in order');
    assert.ok(seg.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lon)));
    const gaps = seg.slice(1).map((p, i) => p.time - seg[i].time);
    assert.ok(Math.max(...gaps) >= 100_000, `a gap of ~2 min for the stop, got ${Math.max(...gaps)} ms`);
    // No jitter points: the path never doubles back by more than 5 m.
    for (let i = 1; i < seg.length; i++) assert.ok(seg[i].lat >= seg[i - 1].lat - 5 * M, `no jitter at ${i}`);
    // The stop's centre appears twice: when the stop began and when walking resumed.
    const gapAt = gaps.indexOf(Math.max(...gaps));
    assert.equal(seg[gapAt].lat, seg[gapAt + 1].lat);
});

test('window: climb over the last 30 s', () => {
    const samples = [];
    for (let s = 0; s <= 60; s++) samples.push({ time: s * 1000, ele: 100 + s * 0.1 }); // 0.1 m/s = 360 m/h
    const w = trimToWindow(samples, 60_000, 30_000);
    assert.equal(w[0].time, 30_000);
    assert.ok(Math.abs(elevationRange(w) - 3) < 1e-9);
    assert.equal(elevationRange([{ ele: null }, { ele: 5 }]), 0);
});

test('gpx: a free recording says it has no elevations', () => {
    const path = new PathRecorder();
    path.startSegment();
    for (let i = 0; i <= 20; i++) path.add({ lat: 40 + i * M, lon: 18, ele: null, time: i * 1000 });
    assert.equal(path.hasElevations, false);
    const text = buildGpx({ name: 'Free recording', desc: NO_ELEVATION_DESC, segments: path.snapshot() });
    assert.doesNotMatch(text, /<ele>/);
    assert.match(text, /<metadata><name>Free recording<\/name><desc>No elevation data/);
    assert.match(text, /<trk><name>Free recording<\/name><desc>No elevation data/);

    path.add({ lat: 40.01, lon: 18, ele: 120, time: 30_000 });
    assert.equal(path.hasElevations, true);
    assert.doesNotMatch(buildGpx({ segments: [[{ lat: 1, lon: 2 }]] }), /<desc>/);
});
