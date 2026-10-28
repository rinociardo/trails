// Elevations from a DEM (Digital Elevation Model) served as map tiles, for
// tracks that have none (free recordings, GPX files without <ele>).
// Pure logic: the caller supplies loadTile(z, x, y), which resolves to
// { width, data } with RGBA pixels (data: Uint8ClampedArray, width × width).

// Fractional tile and pixel position of a point (Web Mercator, as map tiles).
export function tilePosition(lat, lon, z, tileSize = 256) {
    const n = 2 ** z;
    const latRad = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180;
    const fx = (lon + 180) / 360 * n;
    const fy = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n;
    const x = Math.min(n - 1, Math.floor(fx)), y = Math.min(n - 1, Math.floor(fy));
    return { x, y, px: (fx - x) * tileSize, py: (fy - y) * tileSize };
}

// Terrarium encoding (Terrain Tiles): metres = R × 256 + G + B / 256 − 32768.
export function decodeTerrarium(r, g, b) {
    return r * 256 + g + b / 256 - 32768;
}

const DECODERS = { terrarium: decodeTerrarium };

// Bilinear interpolation between the four pixel centres around (px, py);
// pixels are clamped at the tile edge (error at most half a pixel there).
export function sampleTile(tile, px, py, decode = decodeTerrarium) {
    const w = tile.width;
    const at = (x, y) => {
        const i = (Math.max(0, Math.min(w - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4;
        return decode(tile.data[i], tile.data[i + 1], tile.data[i + 2]);
    };
    const x = px - 0.5, y = py - 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const tx = x - x0, ty = y - y0;
    const top = at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx;
    const bottom = at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
}

// Fills points whose ele is missing; points that already have one are kept.
// Returns { points (new array), filled, missing, tiles, tooLarge }. Tiles that fail
// to load leave their points missing. maxTiles guards against huge downloads
// (a track spread over a whole country): nothing is fetched then.
export async function fillFromDem(points, { zoom, tileSize = 256, encoding = 'terrarium', loadTile, maxTiles = 150, concurrency = 6 }) {
    const decode = DECODERS[encoding];
    if (!decode) throw new Error(`Unknown DEM encoding: ${encoding}`);
    const need = [];
    const byTile = new Map();
    points.forEach((p, i) => {
        if (Number.isFinite(p.ele)) return;
        const pos = tilePosition(p.lat, p.lon, zoom, tileSize);
        const key = `${pos.x}/${pos.y}`;
        if (!byTile.has(key)) byTile.set(key, { x: pos.x, y: pos.y, tile: null });
        need.push({ i, key, pos });
    });
    const out = points.map((p) => ({ ...p }));
    if (byTile.size > maxTiles) return { points: out, filled: 0, missing: need.length, tiles: byTile.size, tooLarge: true };

    const queue = [...byTile.values()];
    const worker = async () => {
        while (queue.length) {
            const entry = queue.shift();
            try {
                entry.tile = await loadTile(zoom, entry.x, entry.y);
            } catch {
                entry.tile = null;
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));

    let filled = 0;
    for (const { i, key, pos } of need) {
        const tile = byTile.get(key).tile;
        if (!tile) continue;
        out[i].ele = Math.round(sampleTile(tile, pos.px, pos.py, decode) * 10) / 10;
        filled++;
    }
    return { points: out, filled, missing: need.length - filled, tiles: byTile.size, tooLarge: false };
}
