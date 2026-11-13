import { test } from 'node:test';
import assert from 'node:assert/strict';
import { editWalk, snapPlan, cumulative, entryKind, withNewVersion, restoreVersion, libraryLinks, MAX_SNAP_REQUESTS } from '../walk-edit.js';
import { haversine } from '../geo.js';

const M_LAT = 1 / 111_195;
const M_LON = 1 / (111_195 * Math.cos(46 * Math.PI / 180));
const at = (x, y, ele) => ({ lat: 46 + y * M_LAT, lon: 8 + x * M_LON, ...(ele != null ? { ele } : {}) });
// 1 km north, a point every 5 m, climbing 1 m per 10 m.
const line = Array.from({ length: 201 }, (_, i) => at(0, i * 5, 1000 + i * 0.5));

test('walk edit: trimming both ends keeps the middle, with elevations interpolated at the cuts', () => {
    const r = editWalk(line, { trimStartM: 102, trimEndM: 248 });
    assert.ok(Math.abs(r.length - 650) < 0.5, String(r.length));
    assert.ok(Math.abs(r.original - 1000) < 0.5);
    assert.ok(Math.abs(r.points[0].ele - 1010.2) < 0.01, String(r.points[0].ele));
    assert.equal(r.removed.length, 2);
    assert.ok(haversine(r.removed[0].at(-1), r.points[0]) < 0.01); // removed and kept meet
    // Trimming more than the walk leaves nothing, not an error.
    assert.equal(editWalk(line, { trimStartM: 800, trimEndM: 800 }).length, 0);
});

test('walk edit: cutting out a stretch joins the two sides with a straight line', () => {
    // An out-and-back detour east between 300 m and 500 m along the walk.
    const detour = [];
    for (let d = 0; d <= 1000; d += 5) {
        const x = d > 300 && d < 500 ? 100 - Math.abs(d - 400) : 0;
        detour.push(at(x, d <= 300 ? d : d >= 500 ? d - 200 : 300));
    }
    const total = cumulative(detour).at(-1);
    const r = editWalk(detour, { cut: { fromM: 300, toM: 500 } });
    assert.ok(Math.abs(total - r.length - 200) < 1, `${total} → ${r.length}`);
    assert.equal(r.removed.length, 1);
    // Cut and trim together: the cut is limited to what the trims keep.
    const both = editWalk(line, { trimStartM: 100, cut: { fromM: 50, toM: 200 } });
    assert.ok(Math.abs(both.length - 800) < 0.5, String(both.length));
});

test('walk edit: simplifying keeps the shape with fewer points', () => {
    const r = editWalk(line, { simplifyM: 3 });
    assert.equal(r.points.length, 2);
    assert.ok(Math.abs(r.length - 1000) < 0.5);
    assert.equal(editWalk(line).points.length, 201);
});

test('snap to trails: at most 25 requests, one per segment, all to be routed', () => {
    // A zig-zag walk: 400 corners.
    const zig = Array.from({ length: 401 }, (_, i) => at(i % 2 ? 40 : 0, i * 20));
    const plan = snapPlan(zig);
    assert.ok(plan.requests <= MAX_SNAP_REQUESTS, String(plan.requests));
    assert.equal(plan.segments.length, plan.requests);
    assert.ok(plan.segments.every((s) => s === 'trail') && plan.routes.every((r) => r === null));
    assert.deepEqual(plan.vertices[0], { lat: zig[0].lat, lon: zig[0].lon });
    assert.deepEqual(plan.vertices.at(-1), { lat: zig.at(-1).lat, lon: zig.at(-1).lon });
    // A straight walk: one request.
    assert.equal(snapPlan(line).requests, 1);
    // An L-shaped walk: two.
    const ell = [...line, ...Array.from({ length: 100 }, (_, i) => at((i + 1) * 5, 1000))];
    assert.equal(snapPlan(ell).requests, 2);
});

test('library: walks and tracks, the old version kept on update and restored', () => {
    assert.equal(entryKind({ id: 'walk-1' }), 'walk');
    assert.equal(entryKind({ id: 'plan-1' }), 'track');
    assert.equal(entryKind({ id: 'x', kind: 'walk' }), 'walk');
    const track = { id: 'plan-1', name: 'Ridge', points: [at(0, 0)], eleInfo: { own: 1 }, waypoints: [], plan: { vertices: [] }, savedAt: 1 };
    const updated = withNewVersion(track, { points: [at(0, 0), at(0, 10)], eleInfo: { dem: 2 }, plan: undefined }, 2, 'Updated with walk 2026-11-12');
    assert.equal(updated.points.length, 2);
    assert.equal(updated.versions.length, 1);
    assert.equal(updated.versions[0].points.length, 1);
    assert.equal(updated.versionReason, 'Updated with walk 2026-11-12');
    const back = restoreVersion(updated, 3);
    assert.equal(back.points.length, 1);
    assert.deepEqual(back.plan, { vertices: [] });
    assert.equal(back.versions.length, 0);
    // At most 5 kept.
    let e = track;
    for (let i = 0; i < 8; i++) e = withNewVersion(e, { points: [at(0, i)] }, i, `v${i}`);
    assert.equal(e.versions.length, 5);
    // Links.
    const walk = { id: 'walk-2', kind: 'walk', trackId: 'plan-1' };
    const links = libraryLinks([track, walk, { id: 'walk-3', kind: 'walk' }]);
    assert.equal(links.trackOf(walk), track);
    assert.deepEqual(links.walksOf(track), [walk]);
});
