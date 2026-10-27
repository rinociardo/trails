// Track geometry: distances and "where am I on the route".
// Points are { lat, lon } in degrees; distances are in metres.

const EARTH_RADIUS_M = 6371008.8;

// Penalty (metres of offset per metre of along-track jump) used to keep the
// match continuous on out-and-back or self-crossing routes: a far-away pass of
// the same trail only wins if it is clearly closer than the current one.
const CONTINUITY_WEIGHT = 0.05;

function toRad(deg) {
    return deg * Math.PI / 180;
}

export function haversine(a, b) {
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Precompute cumulative distance so each fix only needs one pass over segments.
export function buildTrack(points) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) {
        cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
    }
    return { points, cum, total: cum[cum.length - 1] };
}

// Closest point on segment a-b to p, using a flat projection centred on p
// (accurate to well under a metre at hiking-segment lengths).
export function projectOnSegment(p, a, b) {
    const kx = Math.cos(toRad(p.lat)) * toRad(1) * EARTH_RADIUS_M;
    const ky = toRad(1) * EARTH_RADIUS_M;
    const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
    const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : -(ax * dx + ay * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx, cy = ay + t * dy;
    return {
        t,
        dist: Math.hypot(cx, cy),
        point: { lat: p.lat + cy / ky, lon: p.lon + cx / kx },
    };
}

// Locate p on the track.
//   offset: true distance to the nearest part of the track (for off-track alerts)
//   along:  distance from the start to the matched point (distance done)
// prevAlong (last matched along, or 0 at start) breaks ties between passes.
export function locateOnTrack(track, p, prevAlong) {
    const { points, cum } = track;
    if (points.length === 1) {
        return { offset: haversine(p, points[0]), along: 0, point: points[0], index: 0 };
    }
    let offset = Infinity;
    let best = null, bestScore = Infinity;
    for (let i = 0; i < points.length - 1; i++) {
        const proj = projectOnSegment(p, points[i], points[i + 1]);
        const along = cum[i] + proj.t * (cum[i + 1] - cum[i]);
        offset = Math.min(offset, proj.dist);
        const score = proj.dist + CONTINUITY_WEIGHT * Math.abs(along - prevAlong);
        if (score < bestScore) {
            bestScore = score;
            best = { along, point: proj.point, index: i };
        }
    }
    return { offset, ...best };
}

// Point at a given distance from the start, plus the index of its segment.
export function pointAtDistance(track, along) {
    const { points, cum, total } = track;
    const d = Math.max(0, Math.min(total, along));
    let i = 0;
    while (i < points.length - 2 && cum[i + 1] < d) i++;
    const segLen = cum[i + 1] - cum[i];
    const t = segLen === 0 ? 0 : (d - cum[i]) / segLen;
    const a = points[i], b = points[i + 1];
    return { lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon), index: i };
}
