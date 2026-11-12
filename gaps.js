// Recording gaps: stretches with no GPS fix while a hike runs (app in the
// background, screen locked, app closed and resumed, or no signal). The walk
// is filled in by guessing the way taken, like the planner does: a straight
// line for short gaps, the loaded track if you were on it before and after,
// otherwise a trail route (up to 3 alternatives, keeping only walking-like ones).
// Pure logic: positions { lat, lon }, times in ms, distances in metres, speeds in m/s.

import { haversine, buildTrack, pointAtDistance } from './geo.js';
import { ClimbCounter } from './walk.js';
import { DEFAULT_ELEVATION_THRESHOLD_M } from './elevation.js';

export const GAP_MIN_MS = 20_000;        // no fix for this long while hiking = a gap
export const GAP_SHORT_M = 50;           // closer than this: straight line, no request
export const GAP_MAX_DETOUR = 3;         // a route over 3× the straight distance is not believed
export const DEFAULT_GAP_MAX_SPEED_MPS = 7 / 3.6; // faster than 7 km/h is not walking
export const DEFAULT_PACE_MPS = 1.2;     // ≈4.3 km/h, when there is no pace before the gap yet
export const MAX_ROUTE_SPAN_DEG = 0.5;   // the relay's limit (≈50 km)

export function pathLength(points) {
    let d = 0;
    for (let i = 1; i < points.length; i++) d += haversine(points[i - 1], points[i]);
    return d;
}

// The loaded track between two distances along it (either way round), with the
// exact points at both ends.
export function trackSlice(track, fromAlong, toAlong) {
    const a = Math.min(fromAlong, toAlong), b = Math.max(fromAlong, toAlong);
    const start = pointAtDistance(track, a), end = pointAtDistance(track, b);
    const inner = [];
    for (let i = start.index + 1; i <= end.index; i++) {
        if (track.cum[i] > a && track.cum[i] < b) inner.push({ lat: track.points[i].lat, lon: track.points[i].lon });
    }
    const points = [{ lat: start.lat, lon: start.lon }, ...inner, { lat: end.lat, lon: end.lon }];
    return fromAlong <= toAlong ? points : points.reverse();
}

// Pace for the gap's time split and for choosing among routes: the walk's
// average moving speed so far, once there is a minute of it; capped to walking.
export function paceBefore({ walked, movingMs }, maxSpeedMps = DEFAULT_GAP_MAX_SPEED_MPS) {
    const pace = movingMs >= 60_000 ? walked / (movingMs / 1000) : DEFAULT_PACE_MPS;
    return Math.min(maxSpeedMps, Math.max(0.3, pace));
}

// Gap time as moving or stopped: the time the filled distance takes at your pace
// is moving (all of it if you must have walked faster), the rest stopped.
export function splitGapTime(distanceM, gapMs, paceMps) {
    const movingMs = Math.min(gapMs, Math.round(distanceM / paceMps * 1000));
    return { movingMs, stoppedMs: gapMs - movingMs };
}

// Route answers -> the options worth showing: joined to the gap's two ends,
// walking-like (implied speed at most maxSpeedMps), at most maxDetour × the
// straight distance. Sorted as they came; chosen = the one whose implied speed is
// closest to your pace. Returns { options, chosen } (options may be empty).
export function routeOptions(paths, { from, to, durationMs, paceMps, maxSpeedMps = DEFAULT_GAP_MAX_SPEED_MPS, maxDetour = GAP_MAX_DETOUR }) {
    const straight = haversine(from, to);
    const seconds = Math.max(1, durationMs / 1000);
    const options = [];
    for (const path of paths) {
        if (!Array.isArray(path) || path.length < 2) continue;
        const points = [{ lat: from.lat, lon: from.lon }, ...path.map((p) => ({ lat: p.lat, lon: p.lon })), { lat: to.lat, lon: to.lon }];
        const distance = pathLength(points);
        const speed = distance / seconds;
        if (speed > maxSpeedMps) continue;
        if (straight > 0 && distance > maxDetour * Math.max(straight, GAP_SHORT_M)) continue;
        options.push({ source: 'route', points, distance, speed });
    }
    let chosen = -1, best = Infinity;
    options.forEach((o, i) => {
        const miss = Math.abs(o.speed - paceMps);
        if (miss < best) { best = miss; chosen = i; }
    });
    return { options, chosen };
}

export function straightOption(from, to, durationMs) {
    const distance = haversine(from, to);
    return { source: 'straight', points: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }], distance, speed: distance / Math.max(1, durationMs / 1000) };
}

// What a gap needs, before any request:
//   'short'  under GAP_SHORT_M: a straight line, final
//   'track'  you were on the loaded track before and after, at a walking-like speed
//   'route'  ask the router (the gap starts as a straight line until it answers)
//   'far'    beyond the router's reach: a straight line, a guess
export function gapPlan({ from, to, durationMs, maxSpeedMps = DEFAULT_GAP_MAX_SPEED_MPS, track = null, alongBefore = null, alongAfter = null }) {
    const straight = haversine(from, to);
    if (straight < GAP_SHORT_M) return { kind: 'short' };
    if (track && alongBefore != null && alongAfter != null) {
        const points = trackSlice(track, alongBefore, alongAfter);
        const distance = pathLength(points);
        if (distance / Math.max(1, durationMs / 1000) <= maxSpeedMps && distance <= GAP_MAX_DETOUR * straight + GAP_SHORT_M) {
            const option = { source: 'track', points: [{ lat: from.lat, lon: from.lon }, ...points, { lat: to.lat, lon: to.lon }] };
            return { kind: 'track', option: measureOption(option, durationMs) };
        }
    }
    if (Math.abs(from.lat - to.lat) > MAX_ROUTE_SPAN_DEG || Math.abs(from.lon - to.lon) > MAX_ROUTE_SPAN_DEG) return { kind: 'far' };
    return { kind: 'route' };
}

// Gives an option its distance and implied speed (after its points change).
export function measureOption(option, durationMs) {
    const distance = pathLength(option.points);
    return { ...option, distance, speed: distance / Math.max(1, durationMs / 1000) };
}

// The gap's numbers for the chosen option: distance, moving/stopped time, and
// ascent/descent from the points' elevations (same hysteresis as the walk).
export function gapNumbers(gap, thresholdM = DEFAULT_ELEVATION_THRESHOLD_M) {
    const option = gap.options[gap.chosen];
    const distance = option ? option.distance : 0;
    const time = splitGapTime(distance, gap.gapMs, gap.paceMps);
    const counter = new ClimbCounter(thresholdM);
    for (const p of option?.points ?? []) counter.add(p.ele);
    return { distance, ...time, ascent: counter.ascent, descent: counter.descent };
}

export function gapTotals(gaps, thresholdM) {
    const t = { walked: 0, movingMs: 0, stoppedMs: 0, ascent: 0, descent: 0 };
    for (const gap of gaps) {
        const n = gapNumbers(gap, thresholdM);
        t.walked += n.distance;
        t.movingMs += n.movingMs;
        t.stoppedMs += n.stoppedMs;
        t.ascent += n.ascent;
        t.descent += n.descent;
    }
    return t;
}

// The chosen option's inner points for the recorded path: flagged with the gap,
// times spread by distance between the two ends (the gap's own timestamps).
export function gapPathPoints(gap) {
    const points = gap.options[gap.chosen]?.points ?? [];
    if (points.length <= 2) return [];
    const { cum, total } = buildTrack(points);
    const t0 = gap.from.time, t1 = gap.to.time;
    return points.slice(1, -1).map((p, i) => ({
        lat: p.lat,
        lon: p.lon,
        ele: Number.isFinite(p.ele) ? p.ele : null,
        time: Math.round(t0 + (t1 - t0) * (total ? cum[i + 1] / total : 0)),
        gap: gap.id,
    }));
}

// Recorded segments split into runs for drawing and export: { gap: id or null,
// points }. A gap's run goes from the last real point before it to the first after
// it (the point marked gapBefore), through its filled points.
export function splitGaps(segments) {
    const runs = [];
    for (const seg of segments) {
        let current = { gap: null, points: [] };
        for (let i = 0; i < seg.length; i++) {
            const p = seg[i];
            const gapId = p.gap ?? p.gapBefore ?? null;
            if (gapId != null) {
                if (current.gap !== gapId) {
                    const prev = seg[i - 1];
                    if (current.points.length) runs.push(current);
                    current = { gap: gapId, points: prev ? [prev] : [] };
                }
                current.points.push(p);
                if (p.gapBefore != null) {
                    runs.push(current);
                    current = { gap: null, points: [p] };
                }
            } else {
                current.points.push(p);
            }
        }
        if (current.points.length) runs.push(current);
    }
    return runs.filter((r) => r.points.length > 1 || (r.gap == null && r.points.length));
}

// Replaces gap id's filled points in the recorded segments (in place).
export function replaceGapPoints(segments, id, points) {
    for (const seg of segments) {
        const end = seg.findIndex((p) => p.gapBefore === id);
        if (end < 0) continue;
        let start = end;
        while (start > 0 && seg[start - 1].gap === id) start--;
        seg.splice(start, end - start, ...points);
        return true;
    }
    return false;
}
