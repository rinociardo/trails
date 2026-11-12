// Everything that touches MapLibre lives here. The app talks to the map only
// through the small object returned by createMapView(), so 3D terrain, tilt
// and other basemaps can be added without touching the hiking logic.

import * as maplibregl from './vendor/maplibre-gl/maplibre-gl.mjs';
import { BASEMAP } from './map-config.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

// Follow mode only moves the map when the position leaves the middle half of
// the screen, so the map is not redrawn on every GPS fix (saves battery).
const FOLLOW_MARGIN = 0.25;

// Track planner: colours, and how far from a point a tap or click still hits it.
const PLAN_COLOR = '#7048e8';
const PLAN_STEEP_COLOR = '#f76707';
const HIT_RADIUS_MOUSE = 10;
const HIT_RADIUS_TOUCH = 22;
const DRAG_START_PX = 4;

function buildStyle(basemap) {
    return {
        version: 8,
        sources: {
            basemap: basemap.source,
            track: { type: 'geojson', data: EMPTY },
            walked: { type: 'geojson', data: EMPTY },
            gaps: { type: 'geojson', data: EMPTY },
            pause: { type: 'geojson', data: EMPTY },
            plan: { type: 'geojson', data: EMPTY },
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
            // The path actually walked: on top of the planned track, in a different colour.
            {
                id: 'walked-casing', type: 'line', source: 'walked',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#ffffff', 'line-width': 5.5 },
            },
            {
                id: 'walked-line', type: 'line', source: 'walked',
                filter: ['!', ['get', 'gap']],
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#d6336c', 'line-width': 3 },
            },
            // Filled recording gaps: a guess, so dashed.
            {
                id: 'walked-gap-line', type: 'line', source: 'walked',
                filter: ['get', 'gap'],
                layout: { 'line-join': 'round' },
                paint: { 'line-color': '#d6336c', 'line-width': 3, 'line-dasharray': [1.5, 1.5] },
            },
            // Smart Pause: the zone you must leave for the hike to resume.
            {
                id: 'pause-fill', type: 'fill', source: 'pause',
                paint: { 'fill-color': '#e8a317', 'fill-opacity': 0.12 },
            },
            {
                id: 'pause-line', type: 'line', source: 'pause',
                paint: { 'line-color': '#b7791f', 'line-width': 2, 'line-dasharray': [2, 1.5] },
            },
            // Reviewing a gap (Track Library): the other options grey, the chosen one pink.
            {
                id: 'gap-options-casing', type: 'line', source: 'gaps',
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#ffffff', 'line-width': ['case', ['get', 'chosen'], 8, 6] },
            },
            {
                id: 'gap-options', type: 'line', source: 'gaps',
                layout: { 'line-join': 'round', 'line-sort-key': ['case', ['get', 'chosen'], 1, 0] },
                paint: {
                    'line-color': ['case', ['get', 'chosen'], '#d6336c', '#8a8f98'],
                    'line-width': ['case', ['get', 'chosen'], 4.5, 3.5],
                    'line-dasharray': [1.5, 1.2],
                },
            },
            {
                id: 'gap-ends', type: 'circle', source: 'gaps',
                filter: ['==', ['geometry-type'], 'Point'],
                paint: { 'circle-radius': 5, 'circle-color': '#d6336c', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
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
            // Track planner: straight (cross-country) segments dashed, trail segments
            // solid, steep straight ones orange; points to drag, and a smaller handle
            // in the middle of each segment for inserting a point.
            {
                id: 'plan-casing', type: 'line', source: 'plan',
                filter: ['==', ['get', 'kind'], 'segment'],
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.8 },
            },
            {
                id: 'plan-trail', type: 'line', source: 'plan',
                filter: ['all', ['==', ['get', 'kind'], 'segment'], ['==', ['get', 'type'], 'trail']],
                layout: { 'line-join': 'round', 'line-cap': 'round' },
                paint: {
                    'line-color': ['case', ['get', 'steep'], PLAN_STEEP_COLOR, PLAN_COLOR],
                    'line-width': 4,
                    'line-opacity': ['case', ['get', 'pending'], 0.4, 1], // still being routed
                },
            },
            {
                id: 'plan-straight', type: 'line', source: 'plan',
                filter: ['all', ['==', ['get', 'kind'], 'segment'], ['==', ['get', 'type'], 'straight']],
                layout: { 'line-join': 'round' },
                paint: {
                    'line-color': ['case', ['get', 'steep'], PLAN_STEEP_COLOR, PLAN_COLOR],
                    'line-width': 4,
                    'line-dasharray': [2, 1.5],
                },
            },
            {
                id: 'plan-mids', type: 'circle', source: 'plan',
                filter: ['==', ['get', 'kind'], 'mid'],
                paint: {
                    'circle-radius': 5,
                    'circle-color': '#ffffff',
                    'circle-opacity': 0.85,
                    'circle-stroke-color': PLAN_COLOR,
                    'circle-stroke-width': 1.5,
                },
            },
            {
                id: 'plan-vertices', type: 'circle', source: 'plan',
                filter: ['==', ['get', 'kind'], 'vertex'],
                paint: {
                    'circle-radius': 7,
                    'circle-color': ['match', ['get', 'role'], 'start', '#2e7d32', 'end', '#c62828', '#ffffff'],
                    'circle-stroke-color': PLAN_COLOR,
                    'circle-stroke-width': 3,
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

// plan: { vertices: [{lat, lon}], segments: ['straight'|'trail'], lines: [[{lat, lon}]] per
// segment, mids: [{lat, lon}] per segment, steep and pending: Sets of segment indexes }
function planGeoJson({ vertices, segments, lines, mids, steep, pending }) {
    const features = [];
    const coord = (v) => [v.lon, v.lat];
    segments.forEach((type, i) => {
        features.push({
            type: 'Feature',
            properties: { kind: 'segment', type, steep: steep.has(i), pending: pending.has(i), index: i },
            geometry: { type: 'LineString', coordinates: lines[i].map(coord) },
        });
        if (mids[i]) {
            features.push({
                type: 'Feature',
                properties: { kind: 'mid', index: i },
                geometry: { type: 'Point', coordinates: coord(mids[i]) },
            });
        }
    });
    vertices.forEach((v, i) => {
        const role = i === 0 ? 'start' : i === vertices.length - 1 ? 'end' : 'middle';
        features.push({ type: 'Feature', properties: { kind: 'vertex', index: i, role }, geometry: { type: 'Point', coordinates: coord(v) } });
    });
    return { type: 'FeatureCollection', features };
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

    // ---- Track planner editing: mouse and touch ----
    // handlers: { add(p), tapVertex(i), tapMid(s), dragVertex(i, p, phase), dragMid(s, p, phase) }
    // with phase 'start' | 'move' | 'end'.
    let planHandlers = null;
    let drag = null;          // { kind, index, start: {x, y}, moved, touch }
    let suppressClickUntil = 0;

    const toPoint = (lngLat) => ({ lat: lngLat.lat, lon: lngLat.lng });

    // The plan point or middle handle under the pointer (points win), or null.
    function hitPlan(point, radius) {
        const box = [[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]];
        const features = map.queryRenderedFeatures(box, { layers: ['plan-vertices', 'plan-mids'] });
        let best = null, bestD = Infinity;
        for (const f of features) {
            const p = map.project(f.geometry.coordinates);
            const d = Math.hypot(p.x - point.x, p.y - point.y) - (f.properties.kind === 'vertex' ? radius : 0);
            if (d < bestD) { bestD = d; best = { kind: f.properties.kind, index: f.properties.index }; }
        }
        return best;
    }

    function onDown(e) {
        if (!planHandlers) return;
        const touch = e.type === 'touchstart';
        if (touch && e.points.length !== 1) return; // pinch zoom stays a map gesture
        const hit = hitPlan(e.point, touch ? HIT_RADIUS_TOUCH : HIT_RADIUS_MOUSE);
        if (!hit) return;
        e.preventDefault(); // the map must not pan while a point is dragged
        drag = { ...hit, start: e.point, moved: false, touch };
        map.on(touch ? 'touchmove' : 'mousemove', onMove);
        map.once(touch ? 'touchend' : 'mouseup', onUp);
    }

    function onMove(e) {
        if (!drag) return;
        if (!drag.moved) {
            if (Math.hypot(e.point.x - drag.start.x, e.point.y - drag.start.y) < DRAG_START_PX) return;
            drag.moved = true;
            dragCallback('start', e.lngLat);
        }
        e.preventDefault();
        dragCallback('move', e.lngLat);
    }

    function dragCallback(phase, lngLat) {
        if (drag.kind === 'vertex') planHandlers.dragVertex(drag.index, toPoint(lngLat), phase);
        else planHandlers.dragMid(drag.index, toPoint(lngLat), phase);
    }

    function onUp(e) {
        map.off(drag.touch ? 'touchmove' : 'mousemove', onMove);
        if (drag.moved) dragCallback('end', e.lngLat);
        else if (drag.kind === 'vertex') planHandlers.tapVertex(drag.index);
        else planHandlers.tapMid(drag.index);
        drag = null;
        suppressClickUntil = Date.now() + 400; // the click that follows is not "add a point"
    }

    map.on('mousedown', onDown);
    map.on('touchstart', onDown);
    map.on('click', (e) => {
        if (!planHandlers || Date.now() < suppressClickUntil) return;
        if (hitPlan(e.point, HIT_RADIUS_MOUSE)) return;
        planHandlers.add(toPoint(e.lngLat));
    });
    // Pointer cursor over draggable points on the Mac.
    map.on('mousemove', (e) => {
        if (!planHandlers || drag) return;
        map.getCanvas().style.cursor = hitPlan(e.point, HIT_RADIUS_MOUSE) ? 'pointer' : 'crosshair';
    });

    // Long-press: a finger held still for 0.6 s (iPhone has no contextmenu event).
    let longPress = null, pressTimer = null, pressStart = null, pointMenu = null;
    const cancelPress = () => { clearTimeout(pressTimer); pressTimer = null; };
    map.on('touchstart', (e) => {
        cancelPress();
        if (!longPress || planHandlers || e.points.length !== 1) return;
        pressStart = e.point;
        const lngLat = e.lngLat;
        pressTimer = setTimeout(() => {
            pressTimer = null;
            suppressClickUntil = Date.now() + 600;
            longPress(toPoint(lngLat));
        }, 600);
    });
    map.on('touchmove', (e) => {
        if (pressTimer && Math.hypot(e.point.x - pressStart.x, e.point.y - pressStart.y) > 10) cancelPress();
    });
    map.on('touchend', cancelPress);
    map.on('touchcancel', cancelPress);
    map.on('dragstart', cancelPress);
    map.on('zoomstart', cancelPress);
    map.on('contextmenu', (e) => {
        if (!longPress || planHandlers) return;
        e.preventDefault();
        longPress(toPoint(e.lngLat));
    });

    // Pin for a place found by search (MapLibre's default marker, in the brand colour).
    const placePin = new maplibregl.Marker({ color: '#2b4c3f' });

    // A track's waypoints, and the trail-guide importer's numbered pins.
    let waypointMarkers = [];
    let guidePins = [];
    const removeAll = (markers) => markers.forEach((m) => m.remove());

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

        // segments: arrays of { lat, lon } (one per Start..Stop); empty clears it.
        // runs: [{ gap (id or null), points }] (gaps.js splitGaps); filled gaps are dashed.
        setWalked(runs) {
            const line = (gap) => runs.filter((r) => (r.gap != null) === gap && r.points.length > 1)
                .map((r) => r.points.map((p) => [p.lon, p.lat]));
            const features = [false, true]
                .map((gap) => ({ gap, coordinates: line(gap) }))
                .filter((f) => f.coordinates.length)
                .map(({ gap, coordinates }) => ({ type: 'Feature', properties: { gap }, geometry: { type: 'MultiLineString', coordinates } }));
            ready.then(() => map.getSource('walked').setData({ type: 'FeatureCollection', features }));
        },

        // Smart Pause zone (null clears it).
        setPauseZone(centre, radiusM) {
            ready.then(() => map.getSource('pause').setData(centre ? circlePolygon(centre, radiusM) : EMPTY));
        },

        // A small menu at a point (coordinates, Copy, Start/End here); null closes it.
        showPointMenu(point, content) {
            pointMenu?.remove();
            pointMenu = null;
            if (!point) return;
            pointMenu = new maplibregl.Popup({ closeButton: true, closeOnClick: true, offset: 14, maxWidth: '280px' })
                .setLngLat([point.lon, point.lat])
                .setDOMContent(content)
                .addTo(map);
        },

        // Long-press on the map (or right-click on the Mac): callback({ lat, lon }).
        // Not while editing a plan, where a held finger drags points.
        onLongPress(callback) {
            longPress = callback;
        },

        // Reviewing a gap: options [{ points, chosen }], or null to clear. Fits them in view.
        setGapReview(options) {
            if (!options) {
                ready.then(() => map.getSource('gaps').setData(EMPTY));
                return;
            }
            const features = options.map((o, index) => ({
                type: 'Feature',
                properties: { index, chosen: Boolean(o.chosen) },
                geometry: { type: 'LineString', coordinates: o.points.map((p) => [p.lon, p.lat]) },
            }));
            const ends = options[0] ? [options[0].points[0], options[0].points.at(-1)] : [];
            for (const p of ends) features.push({ type: 'Feature', properties: { chosen: true }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
            ready.then(() => map.getSource('gaps').setData({ type: 'FeatureCollection', features }));
            const all = options.flatMap((o) => o.points);
            if (all.length) {
                const lons = all.map((p) => p.lon), lats = all.map((p) => p.lat);
                map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
                    { padding: { top: 60, bottom: 220, left: 40, right: 40 }, maxZoom: 17, duration: 0 });
            }
        },

        // The gap option under a tap (index), or null.
        hitGapOption(point, radius = 16) {
            const box = [[point.x - radius, point.y - radius], [point.x + radius, point.y + radius]];
            const hit = map.queryRenderedFeatures(box, { layers: ['gap-options'] })
                .filter((f) => !f.properties.chosen);
            return hit.length ? hit[0].properties.index : null;
        },

        // Track planner: start/stop editing (handlers: see hitPlan above) and draw the plan.
        startPlanEditing(handlers) {
            planHandlers = handlers;
            following = false;
            map.doubleClickZoom.disable(); // a quick second tap adds a point instead
            map.getCanvas().style.cursor = 'crosshair';
        },

        stopPlanEditing() {
            planHandlers = null;
            drag = null;
            map.doubleClickZoom.enable();
            map.getCanvas().style.cursor = '';
            ready.then(() => map.getSource('plan').setData(EMPTY));
        },

        setPlan(plan) {
            ready.then(() => map.getSource('plan').setData(planGeoJson(plan)));
        },

        jumpTo({ lat, lon }, zoom = 15) {
            map.jumpTo({ center: [lon, lat], zoom });
        },

        clearTrack() {
            ready.then(() => map.getSource('track').setData(EMPTY));
        },

        // A place found by search: fit its area (bbox [west, south, east, north])
        // or zoom in on the point, with a pin until another place or clearPlace().
        showPlace({ lat, lon, bbox }) {
            placePin.setLngLat([lon, lat]).addTo(map);
            const small = !bbox || (Math.abs(bbox[2] - bbox[0]) < 0.002 && Math.abs(bbox[3] - bbox[1]) < 0.002);
            if (small) map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), 15), duration: 800 });
            else map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 40, maxZoom: 15, duration: 800 });
        },

        clearPlace() {
            placePin.remove();
        },

        // padding: pixels, or { top, bottom, left, right } to keep clear of a panel.
        fitTrack(points, padding = 40) {
            const bounds = new maplibregl.LngLatBounds();
            for (const p of points) bounds.extend([p.lon, p.lat]);
            map.fitBounds(bounds, { padding, maxZoom: 16, duration: 0 });
        },

        // [{ lat, lon, restroom, title, note }]: a marker per waypoint; tap for its note.
        setWaypoints(waypoints) {
            removeAll(waypointMarkers);
            waypointMarkers = (waypoints ?? []).map((w) => {
                const element = document.createElement('div');
                element.className = w.restroom ? 'waypoint-marker restroom' : 'waypoint-marker';
                if (w.restroom) element.innerHTML = '<svg aria-hidden="true"><use href="#icon-restroom"/></svg>';
                const content = document.createElement('div');
                const title = document.createElement('b');
                title.textContent = w.title;
                const note = document.createElement('div');
                note.textContent = w.note ?? '';
                content.append(title, note);
                const popup = new maplibregl.Popup({ offset: 12, maxWidth: '260px' }).setDOMContent(content);
                return new maplibregl.Marker({ element }).setLngLat([w.lon, w.lat]).setPopup(popup).addTo(map);
            });
        },

        // Trail-guide importer: [{ lat, lon, label, status, active }] as numbered pins.
        // onTap(i) when one is tapped, onDrag(i, { lat, lon }) when one is moved.
        setGuidePins(pins, { onTap, onDrag } = {}) {
            removeAll(guidePins);
            guidePins = pins.map((pin, i) => {
                const element = document.createElement('button');
                element.type = 'button';
                element.className = `guide-pin ${pin.status}${pin.active ? ' active' : ''}`;
                element.textContent = pin.label;
                element.addEventListener('click', (e) => {
                    e.stopPropagation();
                    onTap?.(i);
                });
                const marker = new maplibregl.Marker({ element, draggable: true }).setLngLat([pin.lon, pin.lat]).addTo(map);
                marker.on('dragend', () => onDrag?.(i, toPoint(marker.getLngLat())));
                return marker;
            });
        },

        // The next tap on the map, once (the importer's "tap the map" for a place).
        pickPoint(callback) {
            map.getCanvas().style.cursor = 'crosshair';
            map.once('click', (e) => {
                map.getCanvas().style.cursor = '';
                callback(toPoint(e.lngLat));
            });
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

        getCenter() {
            const { lat, lng } = map.getCenter();
            return { lat, lon: lng };
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
