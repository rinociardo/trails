import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanEditor, densify, slopeProbes, slopeFromProbes, steepSegments, simplify, routeLine, midpoint, planFromWalk, lineLength } from '../plan.js';
import { haversine } from '../geo.js';

const M = 1 / 111195; // degrees of latitude per metre
const at = (northM, eastM = 0) => ({ lat: 46 + northM * M, lon: 11 + eastM * M / Math.cos(46 * Math.PI / 180) });

test('plan: append, move, insert, remove and undo', () => {
    const plan = new PlanEditor();
    plan.append(at(0));
    assert.deepEqual(plan.segments, []);
    plan.append(at(100));
    plan.append(at(200));
    assert.deepEqual(plan.segments, ['straight', 'straight']);

    plan.setType(1, 'trail');
    const i = plan.insert(1, at(150, 20));
    assert.equal(i, 2);
    assert.equal(plan.vertices.length, 4);
    assert.deepEqual(plan.segments, ['straight', 'trail', 'trail']);

    plan.checkpoint();
    plan.move(0, at(-10));
    plan.remove(1); // inner point: its two segments become one, of the first one's type
    assert.equal(plan.vertices.length, 3);
    assert.deepEqual(plan.segments, ['straight', 'trail']);
    plan.remove(2); // last point
    assert.deepEqual(plan.segments, ['straight']);
    plan.remove(0); // first point
    assert.deepEqual(plan.segments, []);
    assert.equal(plan.vertices.length, 1);

    for (let k = 0; k < 4; k++) plan.undo(); // remove ×3, then the move
    assert.equal(plan.vertices.length, 4);
    assert.ok(Math.abs(plan.vertices[0].lat - at(0).lat) < 1e-12, 'the drag is undone in one step');
    plan.undo(); plan.undo(); plan.undo(); // insert, setType, last append
    assert.equal(plan.vertices.length, 2);
    assert.deepEqual(plan.segments, ['straight']);
});

test('plan: densify keeps vertices and adds a point every 25 m', () => {
    const pts = densify({ vertices: [at(0), at(90), at(100)], segments: ['straight', 'trail'] });
    assert.equal(pts.length, 4 + 1 + 1); // 90 m -> 4 parts, 10 m -> 1, plus the end
    assert.ok(pts.slice(0, 4).every((p) => p.straight && p.seg === 0));
    assert.ok(pts.slice(4).every((p) => !p.straight && p.seg === 1));
    assert.ok(haversine(pts[1], at(22.5)) < 0.01);
    assert.equal(densify({ vertices: [at(0)], segments: [] }).length, 1);
});

test('plan: terrain slope from the four probes', () => {
    const p = at(0);
    const probes = slopeProbes(p, 15);
    assert.ok(Math.abs(haversine(p, probes[0]) - 15) < 0.05);
    assert.ok(Math.abs(haversine(p, probes[2]) - 15) < 0.05);
    // Rising 1 m per metre to the north: 45°.
    assert.ok(Math.abs(slopeFromProbes([115, 85, 100, 100]) - 45) < 1e-9);
    assert.equal(slopeFromProbes([100, 100, 100, 100]), 0);
    assert.equal(slopeFromProbes([100, null, 100, 100]), null);
    const pts = [{ seg: 0, straight: true }, { seg: 0, straight: true }, { seg: 1, straight: false }, { seg: 2, straight: true }];
    assert.deepEqual(steepSegments(pts, [10, 38, 50, 20], 30), [{ seg: 0, maxDeg: 38 }]);
});

test('plan: simplify a recorded walk', () => {
    const walk = [];
    for (let i = 0; i <= 100; i++) walk.push(at(i * 5, i <= 50 ? 0 : (i - 50) * 5)); // north 250 m, then north-east
    const s = simplify(walk, 3);
    assert.equal(s.length, 3);
    assert.equal(s[1], walk[50]);
});

test('plan: routes are cleared by edits next to them, kept by undo', () => {
    const plan = new PlanEditor({ vertices: [at(0), at(100), at(200), at(300)], segments: ['trail', 'trail', 'straight'] });
    assert.deepEqual(plan.unrouted, [0, 1]);
    const r0 = [at(0), at(50, 10), at(100)], r1 = [at(100), at(150, 10), at(200)];
    plan.setRoute(0, r0);
    plan.setRoute(1, r1);
    assert.deepEqual(plan.unrouted, []);
    plan.checkpoint();
    plan.move(1, at(100, 20)); // both segments at point 1 need routing again
    assert.deepEqual(plan.unrouted, [0, 1]);
    plan.undo();
    assert.equal(plan.routes[0], r0, 'undo brings the route back without asking the router');
    plan.insert(1, at(150));
    assert.deepEqual(plan.unrouted, [1, 2]);
    assert.equal(plan.routes[0], r0);
    plan.undo();
    plan.fallBack(1); // no usable route: straight, not an undo step
    assert.deepEqual(plan.segments, ['trail', 'straight', 'straight']);
    plan.setType(1, 'trail');
    assert.deepEqual(plan.unrouted, [1]);
    plan.undo();
    assert.deepEqual(plan.segments, ['trail', 'straight', 'straight']);
    plan.remove(1); // merged segment needs routing again
    assert.deepEqual(plan.segments, ['trail', 'straight']);
    assert.equal(plan.routes[0], null);
});

test('plan: a route more than 3× the straight distance is not used', () => {
    const a = at(0), b = at(100);
    const near = routeLine(a, b, [at(0, 5), at(50, 20), at(100, 5)]);
    assert.ok(near.line && near.ratio < 1.5);
    assert.equal(near.line[0], a);
    assert.equal(near.line.at(-1), b);
    const detour = routeLine(a, b, [at(0, 5), at(0, 200), at(100, 200), at(100, 5)]); // ≈ 510 m for 100 m
    assert.equal(detour.line, null);
    assert.ok(detour.ratio > 3);
    assert.ok(Math.abs(haversine(midpoint([at(0), at(100), at(100, 100)]), at(100)) < 0.01));
});

test('plan: densify follows routes; a walk becomes trail segments with its own path', () => {
    const plan = { vertices: [at(0), at(100)], segments: ['trail'], routes: [[at(0), at(50, 50), at(100)]] };
    const pts = densify(plan);
    assert.ok(Math.abs(lineLength(pts) - lineLength(plan.routes[0])) < 0.5);
    assert.ok(pts.every((p) => !p.straight));
    const walk = [];
    for (let i = 0; i <= 100; i++) walk.push(at(i * 5, i <= 50 ? 0 : (i - 50) * 5));
    const w = planFromWalk(walk);
    assert.deepEqual(w.segments, ['trail', 'trail']);
    assert.equal(w.routes[0].length, 51);
    assert.equal(new PlanEditor(w).unrouted.length, 0);
});
