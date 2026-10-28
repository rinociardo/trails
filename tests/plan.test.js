import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanEditor, densify, slopeProbes, slopeFromProbes, steepSegments, simplify } from '../plan.js';
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
