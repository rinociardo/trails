// After a walk: trimming its ends, cutting out a stretch, simplifying, the plan
// for snapping it to trails, and Track Library entries (walks and tracks, links,
// earlier versions kept for Restore).
// Pure logic: points { lat, lon, ele? }, distances in metres.

import { haversine } from './geo.js';
import { simplify, SEGMENT_TRAIL } from './plan.js';

export const MAX_SNAP_REQUESTS = 25;   // the relay allows 30 a minute; the planner asks one at a time
export const MAX_VERSIONS = 5;         // earlier versions kept per Track Library entry

// Distance from the start at every point.
export function cumulative(points) {
    const cum = [0];
    for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]));
    return cum;
}

// The point at distance d along the line (elevation interpolated too).
function pointAt(points, cum, d) {
    if (d <= 0) return { ...points[0] };
    const total = cum.at(-1);
    if (d >= total) return { ...points.at(-1) };
    let i = 1;
    while (cum[i] < d) i++;
    const a = points[i - 1], b = points[i];
    const f = cum[i] === cum[i - 1] ? 0 : (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
    const p = { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
    if (Number.isFinite(a.ele) && Number.isFinite(b.ele)) p.ele = a.ele + (b.ele - a.ele) * f;
    return p;
}

// The part of the line between distances from and to (from < to).
export function slice(points, cum, from, to) {
    if (to <= from) return [];
    const out = [pointAt(points, cum, from)];
    for (let i = 0; i < points.length; i++) if (cum[i] > from && cum[i] < to) out.push({ ...points[i] });
    out.push(pointAt(points, cum, to));
    return out;
}

// The walk as edited. trimStartM / trimEndM: metres removed at each end;
// cut: { fromM, toM } (distances from the start of the walk) removed in the
// middle, the two sides joined by a straight line; simplifyM: Douglas-Peucker
// tolerance (0 = keep every point).
// Returns { points, removed: [runs of points], length, original }.
export function editWalk(points, { trimStartM = 0, trimEndM = 0, cut = null, simplifyM = 0 } = {}) {
    const cum = cumulative(points);
    const total = cum.at(-1) ?? 0;
    const start = Math.max(0, Math.min(total, trimStartM));
    const end = Math.max(start, total - Math.max(0, trimEndM));
    const removed = [];
    if (start > 0) removed.push(slice(points, cum, 0, start));
    if (end < total) removed.push(slice(points, cum, end, total));
    let kept;
    const cutFrom = cut ? Math.max(start, Math.min(cut.fromM, cut.toM)) : 0;
    const cutTo = cut ? Math.min(end, Math.max(cut.fromM, cut.toM)) : 0;
    if (cut && cutTo > cutFrom) {
        removed.push(slice(points, cum, cutFrom, cutTo));
        const before = slice(points, cum, start, cutFrom);
        const after = slice(points, cum, cutTo, end);
        const joint = before.length && after.length && haversine(before.at(-1), after[0]) < 0.5;
        kept = [...before, ...after.slice(joint ? 1 : 0)];
    } else {
        kept = slice(points, cum, start, end);
    }
    if (simplifyM > 0 && kept.length > 2) kept = simplify(kept, simplifyM);
    kept = kept.map(({ lat, lon, ele }) => (Number.isFinite(ele) ? { lat, lon, ele } : { lat, lon }));
    return { points: kept, removed: removed.filter((r) => r.length >= 2), length: cumulative(kept).at(-1) ?? 0, original: total };
}

// A plan for snapping the walk to trails: points kept with the smallest
// tolerance that needs at most maxRequests routing requests (one per segment).
export function snapPlan(points, maxRequests = MAX_SNAP_REQUESTS) {
    let toleranceM = 10, vertices = simplify(points, toleranceM);
    while (vertices.length - 1 > maxRequests && toleranceM < 5000) {
        toleranceM *= 1.5;
        vertices = simplify(points, toleranceM);
    }
    // Still too many (a very wiggly walk): every n-th point.
    if (vertices.length - 1 > maxRequests) {
        const step = (vertices.length - 1) / maxRequests;
        vertices = Array.from({ length: maxRequests + 1 }, (_, i) => vertices[Math.round(i * step)]);
    }
    vertices = vertices.map(({ lat, lon }) => ({ lat, lon }));
    return {
        vertices,
        segments: vertices.slice(1).map(() => SEGMENT_TRAIL),
        routes: vertices.slice(1).map(() => null),
        requests: vertices.length - 1,
        toleranceM: Math.round(toleranceM),
    };
}

// ---------- Track Library entries ----------

// 'walk' (a recording) or 'track' (planned, imported, made from a walk).
// Entries saved before v0.15.0 have no kind: saved walks had ids "walk-…".
export function entryKind(entry) {
    return entry.kind ?? (String(entry.id).startsWith('walk-') ? 'walk' : 'track');
}

// The entry with new points (or other fields), the old version kept for Restore.
export function withNewVersion(entry, changes, now, reason) {
    const { points, eleInfo, waypoints, plan, savedAt } = entry;
    const old = { points, eleInfo, waypoints, plan, savedAt, reason: entry.versionReason ?? null };
    const versions = [old, ...(entry.versions ?? [])].slice(0, MAX_VERSIONS);
    return { ...entry, ...changes, versions, versionReason: reason, savedAt: now };
}

// Back to the newest kept version (the current one is dropped).
export function restoreVersion(entry, now) {
    const [prev, ...rest] = entry.versions ?? [];
    if (!prev) return entry;
    const restored = { ...entry, points: prev.points, eleInfo: prev.eleInfo, waypoints: prev.waypoints, plan: prev.plan,
        versions: rest, versionReason: prev.reason, savedAt: now, restoredAt: now };
    if (!prev.plan) delete restored.plan;
    return restored;
}

// Links for the Track Library: walks per track id, and the track of each walk.
export function libraryLinks(entries) {
    const tracks = new Map(entries.filter((e) => entryKind(e) === 'track').map((e) => [e.id, e]));
    const walksOf = new Map();
    for (const e of entries) {
        if (entryKind(e) !== 'walk' || !e.trackId) continue;
        if (!walksOf.has(e.trackId)) walksOf.set(e.trackId, []);
        walksOf.get(e.trackId).push(e);
    }
    return { trackOf: (walk) => tracks.get(walk.trackId) ?? null, walksOf: (track) => walksOf.get(track.id) ?? [] };
}
