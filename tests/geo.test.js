import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversine, buildTrack, locateOnTrack, pointAtDistance } from '../geo.js';

// 1 degree of latitude ≈ 111.2 km; offsets below are in degrees.
const M = 1 / 111195;

test('haversine: one degree of latitude', () => {
    const d = haversine({ lat: 40, lon: 18 }, { lat: 41, lon: 18 });
    assert.ok(Math.abs(d - 111195) < 50, `got ${d}`);
});

test('straight track: progress, remaining and offset', () => {
    // 1 km straight north.
    const track = buildTrack([{ lat: 40, lon: 18 }, { lat: 40 + 1000 * M, lon: 18 }]);
    assert.ok(Math.abs(track.total - 1000) < 1);

    const lonPerM = M / Math.cos(40 * Math.PI / 180);
    const loc = locateOnTrack(track, { lat: 40 + 400 * M, lon: 18 + 30 * lonPerM }, 0);
    assert.ok(Math.abs(loc.along - 400) < 1, `along ${loc.along}`);
    assert.ok(Math.abs(loc.offset - 30) < 1, `offset ${loc.offset}`);
});

test('out-and-back: stays on the outbound leg until the turnaround', () => {
    // North 1 km, then back south 1 km along a line 5 m to the east.
    const lonPerM = M / Math.cos(40 * Math.PI / 180);
    const track = buildTrack([
        { lat: 40, lon: 18 },
        { lat: 40 + 1000 * M, lon: 18 },
        { lat: 40 + 1000 * M, lon: 18 + 5 * lonPerM },
        { lat: 40, lon: 18 + 5 * lonPerM },
    ]);
    // Walking out at 300 m, slightly closer to the return leg.
    const out = locateOnTrack(track, { lat: 40 + 300 * M, lon: 18 + 3 * lonPerM }, 250);
    assert.ok(Math.abs(out.along - 300) < 2, `outbound along ${out.along}`);
    // Coming back at the same spot, previous progress already past the turnaround.
    const back = locateOnTrack(track, { lat: 40 + 300 * M, lon: 18 + 3 * lonPerM }, 1650);
    assert.ok(Math.abs(back.along - 1705) < 2, `return along ${back.along}`);
});

test('loop: first fix at the shared start/finish counts as the start', () => {
    const track = buildTrack([
        { lat: 40, lon: 18 },
        { lat: 40 + 500 * M, lon: 18 },
        { lat: 40 + 500 * M, lon: 18.006 },
        { lat: 40, lon: 18 },
    ]);
    const loc = locateOnTrack(track, { lat: 40, lon: 18 }, 0);
    assert.ok(loc.along < 1, `along ${loc.along}`);
});

test('pointAtDistance interpolates and clamps', () => {
    const track = buildTrack([{ lat: 40, lon: 18 }, { lat: 40 + 1000 * M, lon: 18 }]);
    const mid = pointAtDistance(track, 500);
    assert.ok(Math.abs(haversine({ lat: 40, lon: 18 }, mid) - 500) < 1);
    assert.deepEqual(pointAtDistance(track, 5000).lat, track.points[1].lat);
});
