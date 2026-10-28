// GPS position smoothing and moving/stopped detection.
// Positions are { lat, lon }, accuracies and distances in metres, times in ms.

import { haversine } from './geo.js';

export const DEFAULT_TRACKING = {
    maxAccuracyM: 30,  // fixes reported worse than this are discarded
    windowSize: 5,     // good fixes averaged into one smoothed position
    stopRadiusM: 15,   // stopped = staying within max(this, current accuracy)...
    stopTimeS: 30,     // ...for this long
    stopClimbM: 3,     // ...unless the track elevation changed more than this (slow steep climb)
};

// Old fixes never enter the average, e.g. after the app was in the background.
const WINDOW_MAX_AGE_MS = 30_000;
const HISTORY_LIMIT = 600;

// Accuracy-weighted moving average of the last few good fixes.
// Weight = 1 / accuracy², so a ±5 m fix counts four times as much as a ±10 m one.
export class PositionSmoother {
    constructor(options = {}) {
        this.configure({ ...DEFAULT_TRACKING, ...options });
        this.fixes = [];
    }

    configure({ maxAccuracyM, windowSize }) {
        this.maxAccuracyM = maxAccuracyM;
        this.windowSize = Math.max(1, Math.round(windowSize));
    }

    reset() {
        this.fixes = [];
    }

    // fix: { lat, lon, acc, time }. Returns null when the fix is discarded,
    // otherwise the smoothed position { lat, lon, acc, time, count }.
    add(fix) {
        if (!(fix.acc <= this.maxAccuracyM)) return null;
        this.fixes.push(fix);
        this.fixes = this.fixes
            .filter((f) => fix.time - f.time <= WINDOW_MAX_AGE_MS)
            .slice(-this.windowSize);
        let sw = 0, lat = 0, lon = 0;
        for (const f of this.fixes) {
            const w = 1 / Math.max(1, f.acc) ** 2;
            sw += w;
            lat += w * f.lat;
            lon += w * f.lon;
        }
        return { lat: lat / sw, lon: lon / sw, acc: Math.sqrt(1 / sw), time: fix.time, count: this.fixes.length };
    }
}

// Elevation change (max - min) over samples { ele }; 0 when fewer than two are known.
export function elevationRange(samples) {
    const eles = samples.map((p) => p.ele).filter(Number.isFinite);
    return eles.length > 1 ? Math.max(...eles) - Math.min(...eles) : 0;
}

// Keeps the samples { time } of the last windowMs, plus the one just before the
// window start (where we were when it began), as the stop check does. Sorted by time.
export function trimToWindow(samples, now, windowMs) {
    let first = 0;
    for (let i = samples.length - 1; i >= 0; i--) {
        if (samples[i].time <= now - windowMs) { first = i; break; }
    }
    return samples.slice(first);
}

// Records distance actually walked, with moving and stopped time.
// MOVING -> STOPPED when all positions of the last stopTimeS seconds lie within
// max(stopRadiusM, accuracy) of each other; the distance and moving time
// recorded during those seconds are replaced by the straight approach to the
// stop's centre (the rest was GPS jitter).
// STOPPED -> MOVING when a position is farther than that from the stop's centre;
// the distance from the centre to that point is counted, and recording goes on from there.
// Slow steep climbs: if the track elevation at the snapped position changed by
// more than stopClimbM within the window, it is a climb, not a stop.
export class MotionTracker {
    constructor(options = {}) {
        this.configure({ ...DEFAULT_TRACKING, ...options });
        this.reset();
    }

    configure({ stopRadiusM, stopTimeS, stopClimbM = DEFAULT_TRACKING.stopClimbM }) {
        this.stopRadiusM = stopRadiusM;
        this.stopTimeMs = stopTimeS * 1000;
        this.stopClimbM = stopClimbM;
    }

    reset() {
        this.state = 'MOVING';
        this.walked = 0;
        this.movingMs = 0;
        this.stoppedMs = 0;
        this.stoppedSince = null;
        this.anchor = null;
        this.radius = this.stopRadiusM;
        this.history = [];   // { lat, lon, ele, time, walked } while moving
        this.lastPoint = null;
        this.lastTick = null; // null while paused
    }

    start(now) {
        this.lastTick = now;
    }

    // Stop recording (hike paused). Distance walked while paused is not counted.
    pause(now) {
        this.tick(now);
        this.lastTick = null;
        this.lastPoint = null;
        this.history = [];
        // After a pause we may be somewhere else: start fresh rather than
        // "resuming" from the old stop and counting the gap as walked.
        this.state = 'MOVING';
        this.stoppedSince = null;
        this.anchor = null;
    }

    // Adds elapsed time to the current state's clock.
    tick(now) {
        if (this.lastTick == null) return;
        const dt = Math.max(0, now - this.lastTick);
        if (this.state === 'STOPPED') this.stoppedMs += dt;
        else this.movingMs += dt;
        this.lastTick = now;
    }

    // pos: smoothed position; acc: accuracy of the current fix; ele: track
    // elevation at the snapped position (null without a track or elevations).
    // Returns 'stopped' or 'resumed' on a state change, otherwise null.
    update(pos, acc, now, ele = null) {
        this.tick(now);
        this.radius = Math.max(this.stopRadiusM, acc || 0);

        if (this.state === 'STOPPED') {
            if (haversine(pos, this.anchor) <= this.radius) return null;
            // Count the real distance from the stop's centre to here.
            this.walked += haversine(this.anchor, pos);
            this.state = 'MOVING';
            this.stoppedSince = null;
            this.anchor = null;
            this.lastPoint = { lat: pos.lat, lon: pos.lon };
            this.history = [{ lat: pos.lat, lon: pos.lon, ele, time: now, walked: this.walked }];
            return 'resumed';
        }

        if (this.lastPoint) this.walked += haversine(this.lastPoint, pos);
        this.lastPoint = { lat: pos.lat, lon: pos.lon };
        this.history.push({ lat: pos.lat, lon: pos.lon, ele, time: now, walked: this.walked });
        return this.checkStop(now);
    }

    checkStop(now) {
        const windowStart = now - this.stopTimeMs;
        // Keep the last position at or before the window start (we were there
        // when the window began) plus everything after it.
        let first = -1;
        for (let i = this.history.length - 1; i >= 0; i--) {
            if (this.history[i].time <= windowStart) { first = i; break; }
        }
        if (first < 0) {
            this.history = this.history.slice(-HISTORY_LIMIT);
            return null; // not watched for long enough yet
        }
        this.history = this.history.slice(first);

        if (this.spread() > this.radius) return null;
        if (this.climb() > this.stopClimbM) return null;

        const centre = this.centre();
        const start = this.history[0];
        const standingMs = Math.min(now - start.time, this.movingMs);
        // Keep the real approach (window start -> stop centre), drop the jitter.
        this.walked = start.walked + haversine(start, centre);
        this.movingMs -= standingMs;
        this.stoppedMs += standingMs;
        this.state = 'STOPPED';
        this.stoppedSince = now - standingMs;
        this.anchor = centre;
        this.lastPoint = null;
        this.history = [];
        return 'stopped';
    }

    centre() {
        const n = this.history.length;
        return {
            lat: this.history.reduce((s, p) => s + p.lat, 0) / n,
            lon: this.history.reduce((s, p) => s + p.lon, 0) / n,
        };
    }

    // Largest distance between any two watched positions (also shown in the debug view).
    // Measured point-to-point, not from the centre, so a slow walk (positions
    // strung along 30 m in 30 s) is not mistaken for standing still.
    spread() {
        let max = 0;
        const h = this.history;
        for (let i = 0; i < h.length; i++) {
            for (let j = i + 1; j < h.length; j++) max = Math.max(max, haversine(h[i], h[j]));
        }
        return max;
    }

    // Track elevation change (max - min) over the watched positions; 0 when unknown.
    climb() {
        return elevationRange(this.history);
    }

    // What must survive the app being closed: distance and clocks.
    snapshot() {
        return { walked: this.walked, movingMs: this.movingMs, stoppedMs: this.stoppedMs };
    }

    // Restores a snapshot as a paused recording; Start continues it.
    restore({ walked, movingMs, stoppedMs }) {
        this.reset();
        this.walked = walked;
        this.movingMs = movingMs;
        this.stoppedMs = stoppedMs;
    }
}

// The path actually walked, for GPX export: points { lat, lon, ele, time }, one
// segment per Start..Stop. A point is kept every minDistanceM, so a 10 km hike
// is about 2000 points. Stops mirror MotionTracker: the jitter recorded while
// standing is replaced by the stop's centre, at the time the stop began and
// again when walking resumed (the gap in the timestamps is the stop).
export class PathRecorder {
    constructor({ minDistanceM = 5 } = {}) {
        this.minDistanceM = minDistanceM;
        this.segments = [];
    }

    reset() {
        this.segments = [];
    }

    // Start (or Resume): a new segment, unless the last one is still empty.
    startSegment() {
        if (!this.segments.length || this.current().length) this.segments.push([]);
    }

    current() {
        return this.segments[this.segments.length - 1];
    }

    add(p, { force = false } = {}) {
        if (!this.segments.length) this.segments.push([]);
        const seg = this.current();
        const last = seg[seg.length - 1];
        if (!force && last && haversine(last, p) < this.minDistanceM) return;
        seg.push({ lat: p.lat, lon: p.lon, ele: Number.isFinite(p.ele) ? p.ele : null, time: p.time });
    }

    // Called when MotionTracker reports 'stopped' (centre, since = stoppedSince).
    stop(centre, since) {
        const seg = this.segments.length ? this.current() : null;
        if (!seg) return;
        const ele = seg.map((p) => p.ele).filter(Number.isFinite).pop() ?? null;
        while (seg.length > 1 && seg[seg.length - 1].time > since) seg.pop();
        this.add({ ...centre, ele, time: since }, { force: true });
    }

    // Called when MotionTracker reports 'resumed': we stood at the centre until now.
    // Pass the centre read before update(), which clears it.
    resume(centre, now) {
        const seg = this.segments.length ? this.current() : null;
        const ele = seg?.[seg.length - 1]?.ele ?? null;
        this.add({ ...centre, ele, time: now }, { force: true });
    }

    get pointCount() {
        return this.segments.reduce((n, seg) => n + seg.length, 0);
    }

    // False for a free recording (no track): no point has an elevation.
    get hasElevations() {
        return this.segments.some((seg) => seg.some((p) => Number.isFinite(p.ele)));
    }

    get startTime() {
        return this.segments.find((seg) => seg.length)?.[0].time ?? null;
    }

    snapshot() {
        return this.segments;
    }

    restore(segments) {
        this.segments = Array.isArray(segments) ? segments : [];
    }
}
