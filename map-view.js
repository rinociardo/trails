// Everything that touches MapLibre lives here. The app talks to the map only
// through the small object returned by createMapView(), so 3D terrain, tilt
// and other basemaps can be added without touching the hiking logic.

import * as maplibregl from './vendor/maplibre-gl/maplibre-gl.mjs';
import { BASEMAP } from './map-config.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

// Follow mode only moves the map when the position leaves the middle half of
// the screen, so the map is not redrawn on every GPS fix (saves battery).
const FOLLOW_MARGIN = 0.25;

function buildStyle(basemap) {
    return {
        version: 8,
        sources: {
            basemap: basemap.source,
            track: { type: 'geojson', data: EMPTY },
            accuracy: { type: 'geojson', data: EMPTY },
            debug: { type: 'geojson', data: EMPTY },
        },
        layers: [
            { id: 'basemap', type: 'raster', source: 'basemap' },
            // A hillshade layer is inserted here (below 'accuracy-fill') when terrain is on.
            {
                id: 'accuracy-fill', type: 'fill', source: 'accuracy',
                paint: { 'fill-color': '#1e66f5', 'fill-opacity': 0.12 },
            },
            {
                id: 'track-casing', type: 'line', source: 'track',
                filter: ['==', ['geometry-type'], 'LineString'],
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#ffffff', 'line-width': 8 },
            },
            {
                id: 'track-line', type: 'line', source: 'track',
                filter: ['==', ['geometry-type'], 'LineString'],
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#1d4ed8', 'line-width': 4.5 },
            },
            {
                id: 'track-ends', type: 'circle', source: 'track',
                filter: ['==', ['geometry-type'], 'Point'],
                paint: {
                    'circle-radius': 7,
                    'circle-color': ['match', ['get', 'role'], 'start', '#2e7d32', '#c62828'],
                    'circle-stroke-color': '#ffffff',
                    'circle-stroke-width': 2,
                },
            },
            // Debug view: stop circle, raw fixes (orange), discarded fixes (red ring),
            // smoothed positions (blue).
            {
                id: 'debug-stop', type: 'line', source: 'debug',
                filter: ['==', ['geometry-type'], 'Polygon'],
                paint: { 'line-color': '#7b1fa2', 'line-width': 2, 'line-dasharray': [2, 2] },
            },
            {
                id: 'debug-points', type: 'circle', source: 'debug',
                filter: ['==', ['geometry-type'], 'Point'],
                paint: {
                    'circle-radius': ['match', ['get', 'kind'], 'smooth', 3.5, 4],
                    'circle-color': ['match', ['get', 'kind'], 'raw', '#f08c00', 'smooth', '#1e66f5', 'rgba(0,0,0,0)'],
                    'circle-stroke-color': ['match', ['get', 'kind'], 'discarded', '#d32f2f', '#ffffff'],
                    'circle-stroke-width': ['match', ['get', 'kind'], 'discarded', 2, 1],
                },
            },
        ],
    };
}

function circlePolygon(centre, radiusM) {
    return accuracyGeoJson({ lat: centre.lat, lon: centre.lon, acc: radiusM });
}

// Hill shading plus 3D terrain. MapLibre recommends separate sources for the
// two, even when they point at the same elevation tiles.
function enableTerrain(map, terrain) {
    map.addSource('terrain-dem', terrain.source);
    if (terrain.hillshade) {
        map.addSource('hillshade-dem', terrain.source);
        map.addLayer({ id: 'hillshade', type: 'hillshade', source: 'hillshade-dem' }, 'accuracy-fill');
    }
    map.setTerrain({ source: 'terrain-dem', exaggeration: terrain.exaggeration ?? 1 });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
}

function trackGeoJson(points) {
    const coords = points.map((p) => [p.lon, p.lat]);
    return {
        type: 'FeatureCollection',
        features: [
            { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } },
            { type: 'Feature', properties: { role: 'end' }, geometry: { type: 'Point', coordinates: coords[coords.length - 1] } },
            { type: 'Feature', properties: { role: 'start' }, geometry: { type: 'Point', coordinates: coords[0] } },
        ],
    };
}

function accuracyGeoJson(fix) {
    const ring = [];
    const mPerDegLat = 111320;
    const mPerDegLon = mPerDegLat * Math.cos(fix.lat * Math.PI / 180);
    for (let i = 0; i <= 48; i++) {
        const a = (i / 48) * 2 * Math.PI;
        ring.push([fix.lon + Math.cos(a) * fix.acc / mPerDegLon, fix.lat + Math.sin(a) * fix.acc / mPerDegLat]);
    }
    return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export function createMapView({ container, center, zoom, pitch = 0, terrain = null }) {
    const is3d = Boolean(terrain);
    const map = new maplibregl.Map({
        container,
        style: buildStyle(BASEMAP),
        center: [center.lon, center.lat],
        zoom,
        pitch: is3d ? pitch : 0,
        attributionControl: { compact: false },
        // Raster tiles gain nothing above 2x; rendering fewer pixels saves battery on 3x iPhones.
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        fadeDuration: 0,
        // Tilt and rotation stay off on the flat map so a stray gesture can't
        // turn it while hiking; they switch on together with terrain.
        maxPitch: is3d ? 80 : 0,
        dragRotate: is3d,
        touchPitch: is3d,
        pitchWithRotate: is3d,
    });
    if (!is3d) map.touchZoomRotate.disableRotation();

    const ready = new Promise((resolve) => map.once('load', resolve));
    if (is3d) ready.then(() => enableTerrain(map, terrain));

    const dot = document.createElement('div');
    dot.className = 'position-dot';
    const marker = new maplibregl.Marker({ element: dot });
    let markerOnMap = false;
    let following = true;
    let lastFix = null;

    // dragstart only fires for user gestures, not for our own camera moves.
    map.on('dragstart', () => { following = false; });

    function keepInView(fix) {
        const pt = map.project([fix.lon, fix.lat]);
        const { clientWidth: w, clientHeight: h } = map.getContainer();
        const inside = pt.x > w * FOLLOW_MARGIN && pt.x < w * (1 - FOLLOW_MARGIN) &&
            pt.y > h * FOLLOW_MARGIN && pt.y < h * (1 - FOLLOW_MARGIN);
        if (!inside) map.jumpTo({ center: [fix.lon, fix.lat] });
    }

    return {
        ready,

        on(event, handler) {
            map.on(event, handler);
        },

        setTrack(points) {
            ready.then(() => map.getSource('track').setData(trackGeoJson(points)));
        },

        clearTrack() {
            ready.then(() => map.getSource('track').setData(EMPTY));
        },

        fitTrack(points) {
            const bounds = new maplibregl.LngLatBounds();
            for (const p of points) bounds.extend([p.lon, p.lat]);
            map.fitBounds(bounds, { padding: 40, maxZoom: 16, duration: 0 });
        },

        showPosition(fix, { offTrack = false } = {}) {
            lastFix = fix;
            marker.setLngLat([fix.lon, fix.lat]);
            if (!markerOnMap) {
                marker.addTo(map);
                markerOnMap = true;
            }
            dot.classList.toggle('off-track', offTrack);
            ready.then(() => map.getSource('accuracy').setData(accuracyGeoJson(fix)));
            if (following) keepInView(fix);
        },

        clearPosition() {
            marker.remove();
            markerOnMap = false;
            lastFix = null;
            ready.then(() => map.getSource('accuracy').setData(EMPTY));
        },

        // Re-enable follow mode and centre on the last known position.
        // Returns false when there is no position yet.
        centerOnPosition() {
            following = true;
            if (!lastFix) return false;
            map.easeTo({ center: [lastFix.lon, lastFix.lat], zoom: Math.max(map.getZoom(), 16), duration: 300 });
            return true;
        },

        setFollow(on) {
            following = on;
        },

        // debug: { raw: [{lat, lon, accepted}], smooth: [{lat, lon}], stop: {centre, radius} | null },
        // or null to clear.
        setDebug(debug) {
            const features = [];
            if (debug) {
                if (debug.stop) features.push(circlePolygon(debug.stop.centre, debug.stop.radius));
                for (const p of debug.raw) {
                    features.push({
                        type: 'Feature',
                        properties: { kind: p.accepted ? 'raw' : 'discarded' },
                        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                    });
                }
                for (const p of debug.smooth) {
                    features.push({
                        type: 'Feature',
                        properties: { kind: 'smooth' },
                        geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
                    });
                }
            }
            ready.then(() => map.getSource('debug').setData({ type: 'FeatureCollection', features }));
        },
    };
}
