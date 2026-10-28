// Track planning: a list of vertices joined by segments, each either
// 'straight' (cross-country, a straight line) or 'trail' (follows paths; until
// routing exists, also drawn as given). Pure logic, no browser APIs.

import { haversine } from './geo.js';

export const SEGMENT_STRAIGHT = 'straight';
export const SEGMENT_TRAIL = 'trail';
const UNDO_LIMIT = 200;

// vertices: [{ lat, lon }]; segments[i] joins vertices i and i+1.
export class PlanEditor {
    constructor({ vertices = [], segments = [] } = {}) {
        this.vertices = vertices.map(({ lat, lon }) => ({ lat, lon }));
        this.segments = vertices.length > 1
            ? Array.from({ length: vertices.length - 1 }, (_, i) => segments[i] ?? SEGMENT_STRAIGHT)
            : [];
        this.history = [];
    }

    snapshot() {
        return { vertices: this.vertices.map((v) => ({ ...v })), segments: [...this.segments] };
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
        return true;
    }

    // New point at the end, joined by a segment of the given type.
    append(p, type = SEGMENT_STRAIGHT) {
        this.checkpoint();
        this.vertices.push({ lat: p.lat, lon: p.lon });
        if (this.vertices.length > 1) this.segments.push(type);
    }

    // No checkpoint: a drag calls checkpoint() once at its start.
    move(i, p) {
        this.vertices[i] = { lat: p.lat, lon: p.lon };
    }

    // Removing an inner point joins its two segments into one (the first one's type).
    remove(i) {
        this.checkpoint();
        this.vertices.splice(i, 1);
        const n = this.segments.length;
        if (n === 0) return;
        if (i === 0) this.segments.shift();
        else if (i === n) this.segments.pop(); // the last point
        else this.segments.splice(i - 1, 2, this.segments[i - 1]);
    }

    // Splits segment s at p; both halves keep its type. Returns the new vertex index.
    insert(s, p) {
        this.checkpoint();
        this.vertices.splice(s + 1, 0, { lat: p.lat, lon: p.lon });
        this.segments.splice(s, 0, this.segments[s]);
        return s + 1;
    }

    setType(s, type) {
        if (this.segments[s] === type) return;
        this.checkpoint();
        this.segments[s] = type;
    }
}

// Point at fraction t between a and b (straight in lat/lon: fine at hiking distances).
const lerp = (a, b, t) => ({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon) });

// Track points along the plan: every vertex, plus points every stepM on long
// segments so the DEM can give the profile between them. Each point carries
// seg (its segment index) and straight (true on cross-country segments).
export function densify({ vertices, segments }, stepM = 25) {
    const points = [];
    for (let s = 0; s < segments.length; s++) {
        const a = vertices[s], b = vertices[s + 1];
        const n = Math.max(1, Math.ceil(haversine(a, b) / stepM));
        const straight = segments[s] === SEGMENT_STRAIGHT;
        for (let k = 0; k < n; k++) points.push({ ...lerp(a, b, k / n), ele: null, seg: s, straight });
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
