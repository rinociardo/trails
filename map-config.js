// Map data sources. The rest of the app never names a tile provider:
// switching the basemap or turning on 3D terrain happens only in this file.

export const BASEMAP = {
    source: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        maxzoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
    },
};

// Elevation data for hill shading and 3D terrain; null keeps the map flat (2D).
// To enable, provide a MapLibre 'raster-dem' source, for example:
//   export const TERRAIN = {
//       source: { type: 'raster-dem', tiles: ['https://.../{z}/{x}/{y}.png'],
//                 tileSize: 256, encoding: 'terrarium', maxzoom: 15, attribution: '...' },
//       exaggeration: 1.3,
//       hillshade: true,
//   };
export const TERRAIN = null;

// Developer preview only (open the app with ?terrain=demo): MapLibre's demo
// elevation tiles. They only cover the area around Innsbruck (47°N 11°E).
export const DEMO_TERRAIN = {
    source: { type: 'raster-dem', url: 'https://demotiles.maplibre.org/terrain-tiles/tiles.json', tileSize: 256 },
    exaggeration: 1.5,
    hillshade: true,
};
