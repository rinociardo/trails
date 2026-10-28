import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tilePosition, decodeTerrarium, sampleTile, fillFromDem } from '../dem.js';

// A 4×4 tile whose elevation rises 10 m per pixel to the east: pixel column c holds 100 + 10c.
function rampTile(base = 100) {
    const w = 4, data = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) {
        for (let x = 0; x < w; x++) {
            const v = base + 10 * x + 32768; // terrarium: R*256 + G + B/256
            const i = (y * w + x) * 4;
            data[i] = Math.floor(v / 256);
            data[i + 1] = v % 256;
            data[i + 2] = 0;
            data[i + 3] = 255;
        }
    }
    return { width: w, data };
}

test('dem: tile position', () => {
    assert.deepEqual(tilePosition(0, 0, 1), { x: 1, y: 1, px: 0, py: 0 });
    const p = tilePosition(46.5, 11.35, 14); // Bolzano
    assert.equal(p.x, 8708);
    assert.equal(p.y, 5795);
    assert.ok(p.px >= 0 && p.px < 256 && p.py >= 0 && p.py < 256);
});

test('dem: terrarium decoding', () => {
    assert.equal(decodeTerrarium(128, 0, 0), 0);
    assert.equal(decodeTerrarium(132, 232, 128), 1256.5); // 132*256 + 232 + 0.5 - 32768
});

test('dem: bilinear sampling between pixel centres', () => {
    const tile = rampTile();
    assert.equal(sampleTile(tile, 0.5, 0.5), 100); // centre of pixel 0
    assert.equal(sampleTile(tile, 1.5, 2.5), 110);
    assert.equal(sampleTile(tile, 1.0, 1.0), 105); // halfway between columns 0 and 1
    assert.equal(sampleTile(tile, 4.0, 4.0), 130); // clamped at the edge
});

test('dem: fills only missing elevations, one download per tile', async () => {
    let loads = 0;
    const loadTile = async () => { loads++; return rampTile(); };
    const points = [
        { lat: 46.5, lon: 11.35, ele: null },
        { lat: 46.5001, lon: 11.3501, ele: 999 },
        { lat: 46.5002, lon: 11.3502 },
    ];
    const r = await fillFromDem(points, { zoom: 14, tileSize: 4, loadTile });
    assert.equal(r.filled, 2);
    assert.equal(r.missing, 0);
    assert.equal(loads, 1);
    assert.equal(r.points[1].ele, 999);
    assert.ok(r.points[0].ele >= 100 && r.points[0].ele <= 130);
    assert.equal(points[0].ele, null, 'input not modified');
});

test('dem: failed tiles leave points missing; too many tiles fetch nothing', async () => {
    const points = [{ lat: 10, lon: 10 }, { lat: 50, lon: 10 }];
    const r = await fillFromDem(points, {
        zoom: 10,
        loadTile: async (z, x, y) => { if (y > 400) throw new Error('offline'); return rampTile(); },
    });
    assert.equal(r.filled, 1);
    assert.equal(r.missing, 1);
    let loads = 0;
    const big = await fillFromDem(points, { zoom: 10, maxTiles: 1, loadTile: async () => { loads++; return rampTile(); } });
    assert.equal(big.tooLarge, true);
    assert.equal(loads, 0);
});
