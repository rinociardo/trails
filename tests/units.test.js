import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeUnits, defaultUnitSystem, FOOT_M, MILE_M } from '../units.js';

test('units: metric distances, lengths and speeds', () => {
    const u = makeUnits('metric');
    assert.equal(u.distance(850), '850 m');
    assert.equal(u.distance(1250), '1.25 km');
    assert.equal(u.distance(12_400), '12.4 km');
    assert.equal(u.length(812.4), '812 m');
    assert.equal(u.length(2664), '2,664 m');
    assert.equal(u.speed(1.25), '4.5 km/h');
    assert.equal(u.distance(null), '–');
    assert.equal(u.length(NaN), '–');
});

test('units: imperial distances, lengths and speeds', () => {
    const u = makeUnits('imperial');
    assert.equal(u.distance(274), '899 ft');             // under 1,000 ft: feet
    assert.equal(u.distance(0.25 * MILE_M), '0.25 mi');
    assert.equal(u.distance(12.4 * MILE_M), '12.4 mi');
    assert.equal(u.length(812), '2,664 ft');
    assert.equal(u.speed(1.25), '2.8 mph');
});

test('units: settings fields convert both ways and stay in metres inside', () => {
    const ft = makeUnits('imperial');
    assert.equal(ft.toInput(50), 164);
    assert.ok(Math.abs(ft.fromInput(164) - 164 * FOOT_M) < 1e-9);
    assert.equal(ft.toInput(3, 0.5), 10);
    const m = makeUnits('metric');
    assert.equal(m.toInput(3, 0.5), 3);
    assert.equal(m.fromInput(50), 50);
});

test('units: default from the device language', () => {
    assert.equal(defaultUnitSystem('en-US'), 'imperial');
    assert.equal(defaultUnitSystem('it-IT'), 'metric');
    assert.equal(defaultUnitSystem('en'), 'metric');
    assert.equal(defaultUnitSystem(undefined), 'metric');
});
