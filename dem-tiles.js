// Browser side of the DEM: downloads elevation tiles and returns their pixels
// for dem.js. Needs the network. The last few decoded tiles are kept in memory
// (the planner asks again on every change); nothing is stored offline (Stage 3).

import { fillFromDem } from './dem.js';
import { DEM } from './map-config.js';

const CACHE_TILES = 48; // decoded 256×256 tiles are 256 kB each: ≈12 MB at most
const cache = new Map(); // "z/x/y" -> Promise of the tile, oldest first

function loadTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let tile = cache.get(key);
    if (tile) {
        cache.delete(key); // most recently used goes to the end
    } else {
        tile = downloadTile(z, x, y);
        tile.catch(() => cache.delete(key)); // try again next time
    }
    cache.set(key, tile);
    if (cache.size > CACHE_TILES) cache.delete(cache.keys().next().value);
    return tile;
}

async function downloadTile(z, x, y) {
    const url = DEM.tiles.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error(`DEM tile ${z}/${x}/${y}: HTTP ${response.status}`);
    // No colour conversion: the pixel values are elevations, not colours.
    const bitmap = await createImageBitmap(await response.blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const canvas = typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), { width: bitmap.width, height: bitmap.height });
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close?.();
    return { width: canvas.width, data: ctx.getImageData(0, 0, canvas.width, canvas.height).data };
}

// Fills missing elevations of points from the DEM: see fillFromDem().
export function fillElevationsFromDem(points) {
    return fillFromDem(points, { zoom: DEM.sampleZoom, tileSize: DEM.tileSize, encoding: DEM.encoding, loadTile });
}

export const DEM_NAME = DEM.name;
export const DEM_CREDITS = DEM.credits;
