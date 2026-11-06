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

// DEM (Digital Elevation Model) for track elevations: Terrain Tiles, open data on
// AWS (https://registry.opendata.aws/terrain-tiles/), terrarium-encoded PNG tiles,
// free to use with attribution (https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
// Open to any website (CORS). The EU copy of the bucket refuses public access, so the US one is used.
// The same tiles can feed 3D terrain and hill shading (see TERRAIN below).
export const DEM = {
    name: 'Terrain Tiles',
    tiles: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    encoding: 'terrarium',
    tileSize: 256,
    maxzoom: 15,
    // Zoom used to read elevations: 14 ≈ 7 m pixels at 45° latitude, finer than the
    // ~30 m data behind most of Europe; one tile covers about 1.7 km.
    sampleZoom: 14,
    attribution: 'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank" rel="noopener">Terrain Tiles</a> (Mapzen and others)',
    credits: [
        'Terrain Tiles (Mapzen), accessed from https://registry.opendata.aws/terrain-tiles.',
        'Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers.',
        'United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey.',
        'Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich.',
        'Norway terrain data © Kartverket.',
        'United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All rights reserved.',
        'Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017.',
        'Canada terrain data contains information licensed under the Open Government Licence – Canada.',
        'Mexico terrain data source: INEGI, Continental relief, 2016.',
        'New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and the New Zealand Department of Conservation.',
        'ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under National Science Foundation awards 1043681, 1559691, and 1542736.',
        'Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration.',
    ],
};

// The Trails relay (relay/ in the repo, a Cloudflare Worker that holds the owner's
// openrouteservice key as a secret: no key in this code, no setup for users).
// It answers POST /route and POST /geocode only. Empty: routing and search are off.
const RELAY = 'https://trails-relay.rinociardo.workers.dev';

// Trail routing for the planner (decided 2026-10-28): openrouteservice, foot-hiking
// profile, through the relay. Without it, segments are drawn straight.
// The key's limits: 2,000 routes a day, 40 a minute, shared by everyone. Attribution required.
export const ROUTER = {
    name: 'openrouteservice',
    relayUrl: RELAY && `${RELAY}/route`,
    attribution: 'Routes © openrouteservice.org by HeiGIT · map data © OpenStreetMap contributors',
};

// Place search (Explore; later From -> To), decided 2026-10-29: openrouteservice
// geocoding (Pelias) through the relay. Searches run on Enter only (no
// as-you-type suggestions) to save the shared daily quota.
export const GEOCODER = {
    name: 'openrouteservice',
    relayUrl: RELAY && `${RELAY}/geocode`,
    attribution: 'Search © openrouteservice.org by HeiGIT · Pelias · data © OpenStreetMap contributors, Who\'s On First, GeoNames, OpenAddresses',
};

// Elevation data for hill shading and 3D terrain; null keeps the map flat (2D).
// To enable, use the DEM above as a MapLibre 'raster-dem' source:
//   export const TERRAIN = {
//       source: { type: 'raster-dem', tiles: [DEM.tiles], tileSize: DEM.tileSize,
//                 encoding: DEM.encoding, maxzoom: DEM.maxzoom, attribution: DEM.attribution },
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
