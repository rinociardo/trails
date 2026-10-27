// GPS position smoothing and moving/stopped detection.
// Positions are { lat, lon }, accuracies and distances in metres, times in ms.

import { haversine } from './geo.js';

export const DEFAULT_TRACKING = {
    maxAccuracyM: 30,  // fixes reported worse than this are discarded
    windowSize: 5,     // good fixes averaged into one smoothed position
    stopRadiusM: 15,   // stopped = staying within max(this, current accuracy)...
    stopTimeS: 30,     // ...for this long
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

// Records distance actually walked, with moving and stopped time.
// MOVING -> STOPPED when all positions of the last stopTimeS seconds lie within
// max(stopRadiusM, accuracy) of each other; the distance and moving time
// recorded during those seconds are replaced by the straight approach to the
// stop's centre (the rest was GPS jitter).
// STOPPED -> MOVING when a position is farther than that from the stop's centre;
// the distance from the centre to that point is counted, and recording goes on from there.
export class MotionTracker {
    constructor(options = {}) {
        this.configure({ ...DEFAULT_TRACKING, ...options });
        this.reset();
    }

    configure({ stopRadiusM, stopTimeS }) {
        this.stopRadiusM = stopRadiusM;
        this.stopTimeMs = stopTimeS * 1000;
    }

    reset() {
        this.state = 'MOVING';
        this.walked = 0;
        this.movingMs = 0;
        this.stoppedMs = 0;
        this.stoppedSince = null;
        this.anchor = null;
        this.radius = this.stopRadiusM;
        this.history = [];   // { lat, lon, time, walked } while moving
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

    // pos: smoothed position; acc: accuracy of the current fix.
    // Returns 'stopped' or 'resumed' on a state change, otherwise null.
    update(pos, acc, now) {
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
            this.history = [{ lat: pos.lat, lon: pos.lon, time: now, walked: this.walked }];
            return 'resumed';
        }

        if (this.lastPoint) this.walked += haversine(this.lastPoint, pos);
        this.lastPoint = { lat: pos.lat, lon: pos.lon };
        this.history.push({ lat: pos.lat, lon: pos.lon, time: now, walked: this.walked });
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
}
