// Track planning: a list of vertices joined by segments, each either
// 'straight' (cross-country, a straight line) or 'trail' (follows paths: its
// line comes from the router). Pure logic, no browser APIs.

import { haversine } from './geo.js';

export const SEGMENT_STRAIGHT = 'straight';
export const SEGMENT_TRAIL = 'trail';
const UNDO_LIMIT = 200;
export const MAX_DETOUR_RATIO = 3; // a trail route longer than this × the straight line is not used

// vertices: [{ lat, lon }]; segments[i] joins vertices i and i+1; routes[i] is
// the trail line of segment i from vertex to vertex ([{ lat, lon }]), or null
// while it is straight or still has to be routed. Moving a point clears the
// routes of its two segments.
export class PlanEditor {
    constructor({ vertices = [], segments = [], routes = [] } = {}) {
        this.vertices = vertices.map(({ lat, lon }) => ({ lat, lon }));
        const n = Math.max(0, vertices.length - 1);
        this.segments = Array.from({ length: n }, (_, i) => segments[i] ?? SEGMENT_STRAIGHT);
        this.routes = Array.from({ length: n }, (_, i) => (this.segments[i] === SEGMENT_TRAIL ? routes[i] ?? null : null));
        this.history = [];
    }

    // Route lines are never changed in place, so they can be shared with the snapshot.
    snapshot() {
        return { vertices: this.vertices.map((v) => ({ ...v })), segments: [...this.segments], routes: [...this.routes] };
    }

    // Trail segments that still need a route.
    get unrouted() {
        return this.segments.map((t, i) => (t === SEGMENT_TRAIL && !this.routes[i] ? i : -1)).filter((i) => i >= 0);
    }

    // The line drawn for segment s: its route, or straight from point to point.
    line(s) {
        return this.routes[s] ?? [this.vertices[s], this.vertices[s + 1]];
    }

    // Router results are not undo steps: they follow from the edit that needed them.
    setRoute(s, route) {
        this.routes[s] = route;
    }

    // No usable route: the segment becomes straight (an undo brings the trail back).
    fallBack(s) {
        this.segments[s] = SEGMENT_STRAIGHT;
        this.routes[s] = null;
    }

    // Call before every change (once per drag), so Undo goes back one step.
    checkpoint() {
        this.history.push(this.snapshot());
        if (this.history.length > UNDO_LIMIT) this.history.shift();
    }

    get canUndo() {
        return this.history.length > 0;
    }

    undo() {
        const previous = this.history.pop();
        if (!previous) return false;
        this.vertices = previous.vertices;
        this.segments = previous.segments;
        this.routes = previous.routes;
        return true;
    }

    // New point at the end, joined by a segment of the given type.
    append(p, type = SEGMENT_STRAIGHT) {
        this.checkpoint();
        this.vertices.push({ lat: p.lat, lon: p.lon });
        if (this.vertices.length > 1) {
            this.segments.push(type);
            this.routes.push(null);
        }
    }

    // No checkpoint: a drag calls checkpoint() once at its start.
    move(i, p) {
        this.vertices[i] = { lat: p.lat, lon: p.lon };
        if (i > 0) this.routes[i - 1] = null;
        if (i < this.routes.length) this.routes[i] = null;
    }

    // Removing an inner point joins its two segments into one (the first one's type).
    remove(i) {
        this.checkpoint();
        this.vertices.splice(i, 1);
        const n = this.segments.length;
        if (n === 0) return;
        if (i === 0) {
            this.segments.shift();
            this.routes.shift();
        } else if (i === n) { // the last point
            this.segments.pop();
            this.routes.pop();
        } else {
            this.segments.splice(i - 1, 2, this.segments[i - 1]);
            this.routes.splice(i - 1, 2, null);
        }
    }

    // Splits segment s at p; both halves keep its type. Returns the new vertex index.
    insert(s, p) {
        this.checkpoint();
        this.vertices.splice(s + 1, 0, { lat: p.lat, lon: p.lon });
        this.segments.splice(s, 0, this.segments[s]);
        this.routes.splice(s, 1, null, null);
        return s + 1;
    }

    setType(s, type) {
        if (this.segments[s] === type) return;
        this.checkpoint();
        this.segments[s] = type;
        this.routes[s] = null;
    }
}

// Length of a line of points, in metres.
export function lineLength(line) {
    let m = 0;
    for (let i = 1; i < line.length; i++) m += haversine(line[i - 1], line[i]);
    return m;
}

// The router's path, joined to the two points (the router starts and ends on the
// nearest path, which may be off the clicked spot). Returns { line, ratio } with
// line null when the route is unusable: longer than maxRatio × the straight line.
export function routeLine(a, b, path, maxRatio = MAX_DETOUR_RATIO) {
    const line = [a, ...path, b].filter((p, i, all) => i === 0 || p.lat !== all[i - 1].lat || p.lon !== all[i - 1].lon);
    const straight = haversine(a, b);
    const ratio = straight > 0 ? lineLength(line) / straight : 1;
    return { line: ratio > maxRatio ? null : line, ratio, lengthM: lineLength(line), straightM: straight };
}

// Halfway along a line (where the segment's middle handle goes).
export function midpoint(line) {
    const half = lineLength(line) / 2;
    let walked = 0;
    for (let i = 1; i < line.length; i++) {
        const d = haversine(line[i - 1], line[i]);
        if (walked + d >= half) return lerp(line[i - 1], line[i], d ? (half - walked) / d : 0);
        walked += d;
    }
    return line[0];
}

// Point at fraction t between a and b (straight in lat/lon: fine at hiking distances).
function lerp(a, b, t) {
    return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) };
}

// Track points along the plan: every vertex and route point, plus points every
// stepM where they are further apart, so the DEM can give the profile between
// them. Each point carries seg (its segment index) and straight (true on
// cross-country segments).
export function densify({ vertices, segments, routes = [] }, stepM = 25) {
    const points = [];
    for (let s = 0; s < segments.length; s++) {
        const line = routes[s] ?? [vertices[s], vertices[s + 1]];
        const straight = segments[s] === SEGMENT_STRAIGHT;
        for (let j = 0; j < line.length - 1; j++) {
            const a = line[j], b = line[j + 1];
            const n = Math.max(1, Math.ceil(haversine(a, b) / stepM));
            for (let k = 0; k < n; k++) points.push({ ...lerp(a, b, k / n), ele: null, seg: s, straight });
        }
    }
    const last = vertices[vertices.length - 1];
    if (last) {
        const s = Math.max(0, segments.length - 1);
        points.push({ lat: last.lat, lon: last.lon, ele: null, seg: s, straight: segments[s] === SEGMENT_STRAIGHT });
    }
    return points;
}

// For the terrain slope at p: four points offsetM to the north, south, east and west.
export function slopeProbes(p, offsetM = 15) {
    const dLat = offsetM / 111320;
    const dLon = offsetM / (111320 * Math.cos(p.lat * Math.PI / 180));
    return [
        { lat: p.lat + dLat, lon: p.lon, ele: null },
        { lat: p.lat - dLat, lon: p.lon, ele: null },
        { lat: p.lat, lon: p.lon + dLon, ele: null },
        { lat: p.lat, lon: p.lon - dLon, ele: null },
    ];
}

// Terrain slope in degrees from the probes' elevations [N, S, E, W] (central
// differences); null if any is missing.
export function slopeFromProbes(eles, offsetM = 15) {
    if (!eles.every(Number.isFinite)) return null;
    const [n, s, e, w] = eles;
    const gradient = Math.hypot((n - s) / (2 * offsetM), (e - w) / (2 * offsetM));
    return Math.atan(gradient) * 180 / Math.PI;
}

// Steepest terrain slope per straight segment: [{ seg, maxDeg }], for the warning.
export function steepSegments(points, slopes, limitDeg) {
    const worst = new Map();
    points.forEach((p, i) => {
        if (!p.straight || slopes[i] == null) return;
        worst.set(p.seg, Math.max(worst.get(p.seg) ?? 0, slopes[i]));
    });
    return [...worst].filter(([, deg]) => deg > limitDeg).map(([seg, maxDeg]) => ({ seg, maxDeg }));
}

// Douglas-Peucker simplification (tolerance in metres), to turn a recorded
// walk (a point every 5 m) into points that can be dragged.
export function simplify(points, toleranceM = 3) {
    if (points.length <= 2) return points.slice();
    const keep = new Uint8Array(points.length);
    keep[0] = keep[points.length - 1] = 1;
    const stack = [[0, points.length - 1]];
    const kx = 111320 * Math.cos(points[0].lat * Math.PI / 180), ky = 111320;
    while (stack.length) {
        const [first, last] = stack.pop();
        const a = points[first], b = points[last];
        const bx = (b.lon - a.lon) * kx, by = (b.lat - a.lat) * ky;
        const len2 = bx * bx + by * by;
        let maxD = 0, index = -1;
        for (let i = first + 1; i < last; i++) {
            const px = (points[i].lon - a.lon) * kx, py = (points[i].lat - a.lat) * ky;
            const t = len2 ? Math.max(0, Math.min(1, (px * bx + py * by) / len2)) : 0;
            const d = Math.hypot(px - t * bx, py - t * by);
            if (d > maxD) { maxD = d; index = i; }
        }
        if (maxD > toleranceM) {
            keep[index] = 1;
            stack.push([first, index], [index, last]);
        }
    }
    return points.filter((_, i) => keep[i]);
}

// A recorded walk as a plan: simplified points on "trail" segments whose
// routes are the walked path between them, so nothing needs routing.
export function planFromWalk(points, toleranceM = 3) {
    const vertices = simplify(points, toleranceM);
    const index = vertices.map((v) => points.indexOf(v));
    return {
        vertices,
        segments: vertices.slice(1).map(() => SEGMENT_TRAIL),
        routes: vertices.slice(1).map((_, s) => points.slice(index[s], index[s + 1] + 1).map(({ lat, lon }) => ({ lat, lon }))),
    };
}
