// Live numbers of the walk itself, with or without a track: ascent and descent
// from the DEM (Digital Elevation Model) elevation at the smoothed position (never
// GPS altitude), the current speed and the vertical speed.
// Pure logic: elevations in metres, times in ms, speeds in metres per second.

import { DEFAULT_ELEVATION_THRESHOLD_M } from './elevation.js';

// Ascent and descent with the same hysteresis as a track's profile (elevation.js):
// a climb or drop only counts once it exceeds the threshold.
export class ClimbCounter {
    constructor(thresholdM = DEFAULT_ELEVATION_THRESHOLD_M) {
        this.thresholdM = thresholdM;
        this.reset();
    }

    reset() {
        this.ascent = 0;
        this.descent = 0;
        this.anchor = null; // elevation the next climb or drop is measured from
    }

    // After Stop (or reopening) we may be somewhere else: the next elevation starts
    // afresh, as the walked distance does, instead of counting the gap as a climb.
    pause() {
        this.anchor = null;
    }

    add(ele) {
        if (!Number.isFinite(ele)) return;
        if (this.anchor == null) {
            this.anchor = ele;
            return;
        }
        const diff = ele - this.anchor;
        if (diff >= this.thresholdM) {
            this.ascent += diff;
            this.anchor = ele;
        } else if (-diff >= this.thresholdM) {
            this.descent -= diff;
            this.anchor = ele;
        }
    }
}

export const SPEED_WINDOW_MS = 15_000;     // current speed: walked distance over the last 15 s
export const VERTICAL_WINDOW_MS = 60_000;  // vertical speed: elevation trend over the last minute
const VERTICAL_MIN_SPAN_MS = 20_000;       // ...once at least 20 s of it is known
export const LEVEL_MPS = 60 / 3600;        // slower than 60 m an hour counts as level
const MAX_STEP_MS = 5000;                  // a longer gap between fixes adds no climbing time

// Current speed and vertical speed, plus the time spent climbing and descending
// (for the average rates). Fed one sample per GPS fix while moving.
export class WalkRates {
    constructor() {
        this.reset();
    }

    reset() {
        this.upMs = 0;
        this.downMs = 0;
        this.clear();
    }

    // Forget the recent samples (Stop, a stop, reopening); the totals stay.
    clear() {
        this.samples = []; // { time, walked, ele }
    }

    // walked: distance walked so far (MotionTracker); ele: DEM elevation or null.
    add({ time, walked, ele = null }) {
        const prev = this.samples[this.samples.length - 1];
        this.samples.push({ time, walked, ele: Number.isFinite(ele) ? ele : null });
        this.samples = this.samples.filter((s) => time - s.time <= VERTICAL_WINDOW_MS);
        if (!prev) return;
        const dt = Math.min(MAX_STEP_MS, Math.max(0, time - prev.time));
        const v = this.vertical(time);
        if (v > LEVEL_MPS) this.upMs += dt;
        else if (v < -LEVEL_MPS) this.downMs += dt;
    }

    // Metres per second over the last 15 s; null with too little to go on.
    speed(now) {
        const recent = this.samples.filter((s) => now - s.time <= SPEED_WINDOW_MS);
        if (recent.length < 2) return null;
        const a = recent[0], b = recent[recent.length - 1];
        const dt = (b.time - a.time) / 1000;
        return dt > 0 ? Math.max(0, b.walked - a.walked) / dt : null;
    }

    // Elevation trend in metres per second (least-squares slope over the last
    // minute, so one noisy elevation doesn't swing it); up is positive.
    vertical(now) {
        const s = this.samples.filter((p) => p.ele != null && now - p.time <= VERTICAL_WINDOW_MS);
        if (s.length < 2 || s[s.length - 1].time - s[0].time < VERTICAL_MIN_SPAN_MS) return null;
        const t0 = s[0].time;
        const n = s.length;
        const mt = s.reduce((sum, p) => sum + (p.time - t0) / 1000, 0) / n;
        const me = s.reduce((sum, p) => sum + p.ele, 0) / n;
        let num = 0, den = 0;
        for (const p of s) {
            const dt = (p.time - t0) / 1000 - mt;
            num += dt * (p.ele - me);
            den += dt * dt;
        }
        return den > 0 ? num / den : null;
    }
}

// Average climbing rate (ascent over the time spent climbing) and descending
// rate, in metres per second; null until a minute of either has been walked.
export function averageRates(counter, rates) {
    const rate = (m, ms) => (ms >= 60_000 ? m / (ms / 1000) : null);
    return { up: rate(counter.ascent, rates.upMs), down: rate(counter.descent, rates.downMs) };
}

// What survives the app being closed.
export function walkSnapshot(counter, rates) {
    return { ascent: counter.ascent, descent: counter.descent, upMs: rates.upMs, downMs: rates.downMs };
}

export function restoreWalk(counter, rates, saved) {
    counter.reset();
    rates.reset();
    if (!saved) return;
    counter.ascent = saved.ascent || 0;
    counter.descent = saved.descent || 0;
    rates.upMs = saved.upMs || 0;
    rates.downMs = saved.downMs || 0;
}

// Off the track or on it, for both the alert and the numbers: off after
// confirmFixes fixes in a row farther than the limit (filters GPS jumps), back on
// only inside backRatio × the limit (so it doesn't flicker at the edge). The limit
// is per fix: wider on straight (cross-country) segments of a planned track.
export class OffTrackDetector {
    constructor({ confirmFixes = 2, backRatio = 0.8 } = {}) {
        this.confirmFixes = confirmFixes;
        this.backRatio = backRatio;
        this.reset();
    }

    reset() {
        this.farCount = 0;
        this.offTrack = false;
    }

    // Returns 'off' when it goes off track, 'back' when it comes back, else null.
    update(offset, limit) {
        if (offset > limit) {
            this.farCount++;
            if (!this.offTrack && this.farCount >= this.confirmFixes) {
                this.offTrack = true;
                return 'off';
            }
            return null;
        }
        this.farCount = 0;
        if (this.offTrack && offset < limit * this.backRatio) {
            this.offTrack = false;
            return 'back';
        }
        return null;
    }
}

// Off-track alerts: 'off', 'banner' (banner only, the default) or 'sound' (banner + sound).
export const ALERT_MODES = ['off', 'banner', 'sound'];
export const nextAlertMode = (mode) => ALERT_MODES[(ALERT_MODES.indexOf(mode) + 1) % ALERT_MODES.length];
