// Smart Pause: a "pause zone" around where you pressed Pause (a picnic, a
// summit, a café). While paused, positions still come in but nothing counts.
// The watcher decides when you are back on the move: outside the zone and going
// steadily away at walking pace for about a minute (or along the loaded track).
// Pure logic: positions { lat, lon, time }, distances in metres, speeds in m/s.

import { haversine } from './geo.js';
import { pathLength } from './gaps.js';

export const DEFAULT_PAUSE_RADIUS_M = 150;
export const RESUME_AFTER_MS = 60_000;     // about a minute of moving on before resuming
export const PAUSE_HOLE_MS = 20_000;       // no position for this long: phone locked or app away
export const MIN_WALK_MPS = 0.5;           // slower than 1.8 km/h is not "on the move"
export const AWAY_RATIO = 0.5;             // at least half of the way walked must lead away
const MAX_OUTSIDE = 1800;                  // positions kept since leaving the zone (≈30 min)

// Is the walk since leaving the zone a hike carrying on? points: positions since
// the exit (each may have along/onTrack when a track is loaded).
// Returns 'wait' (under a minute yet), 'resume' or 'unclear'.
export function judgeExit(points, centre, { minSpeedMps = MIN_WALK_MPS, maxSpeedMps = 7 / 3.6 } = {}) {
    if (points.length < 2) return 'wait';
    const first = points[0], last = points[points.length - 1];
    const span = (last.time - first.time) / 1000;
    if (span * 1000 < RESUME_AFTER_MS) return 'wait';
    const length = pathLength(points);
    const speed = length / span;
    if (speed < minSpeedMps || speed > maxSpeedMps) return 'unclear';
    const away = haversine(last, centre) - haversine(first, centre);
    if (away >= AWAY_RATIO * length) return 'resume';
    // Along a loaded track (a loop may lead back past the zone): forward progress counts.
    if (points.every((p) => p.onTrack && Number.isFinite(p.along)) && last.along - first.along >= AWAY_RATIO * length) return 'resume';
    return 'unclear';
}

// One pause. Feed it every position; it answers what to do:
//   { action: 'none' }                 inside the zone, or not decided yet
//   { action: 'resume', exit }         back on the move: count from exit (the first
//                                       position outside the zone), see .outside
//   { action: 'ask' }                  outside but unclear: ask "Still paused. Resume?" (once per outing)
//   { action: 'jump', exit, holeFrom } after a hole (phone locked), far outside: you
//                                       walked on unseen; exit is the first position outside
//                                       before the hole, else on the zone's edge (no time)
export class PauseWatcher {
    constructor({ centre, radiusM = DEFAULT_PAUSE_RADIUS_M, since, minSpeedMps, maxSpeedMps }) {
        this.centre = { lat: centre.lat, lon: centre.lon };
        this.radiusM = radiusM;
        this.since = since;
        this.limits = { minSpeedMps, maxSpeedMps };
        this.outside = [];        // positions since the last exit from the zone
        this.asked = false;
        this.autoOff = false;     // after Undo: only a manual Resume ends this pause
        this.lastTime = since;
    }

    inside(p) {
        return haversine(p, this.centre) <= this.radiusM;
    }

    add(p) {
        const holeFrom = this.lastTime;
        const hole = p.time - holeFrom >= PAUSE_HOLE_MS;
        this.lastTime = p.time;
        if (this.inside(p)) {
            this.outside = [];
            this.asked = false;
            return { action: 'none' };
        }
        // Back after the phone was locked (or the app away), well outside the zone:
        // you left while nothing was watching.
        if (hole && haversine(p, this.centre) >= 2 * this.radiusM && !this.autoOff) {
            return { action: 'jump', exit: this.outside[0] ?? this.edgeToward(p), holeFrom };
        }
        this.outside.push(p);
        if (this.outside.length > MAX_OUTSIDE) this.outside.shift();
        if (this.autoOff) return { action: 'none' };
        const verdict = judgeExit(this.outside, this.centre, this.limits);
        if (verdict === 'resume') return { action: 'resume', exit: this.outside[0] };
        if (verdict === 'unclear' && !this.asked) {
            this.asked = true;
            return { action: 'ask' };
        }
        return { action: 'none' };
    }

    // The point where the line from the zone's centre to p crosses its edge.
    edgeToward(p) {
        const d = haversine(this.centre, p);
        const f = d > 0 ? Math.min(1, this.radiusM / d) : 0;
        return { lat: this.centre.lat + (p.lat - this.centre.lat) * f, lon: this.centre.lon + (p.lon - this.centre.lon) * f };
    }

    snapshot() {
        return { centre: this.centre, radiusM: this.radiusM, since: this.since, limits: this.limits,
            outside: this.outside, asked: this.asked, autoOff: this.autoOff, lastTime: this.lastTime };
    }

    static restore(s) {
        const w = new PauseWatcher({ centre: s.centre, radiusM: s.radiusM, since: s.since, ...s.limits });
        Object.assign(w, { outside: s.outside ?? [], asked: Boolean(s.asked), autoOff: Boolean(s.autoOff), lastTime: s.lastTime ?? s.since });
        return w;
    }
}

// How long you were walking before the first position after a hole, at your pace:
// the time is taken from the end of the pause (the rest stays paused).
export function walkedUnseenMs(exit, p, paceMps, holeMs) {
    return Math.min(holeMs, Math.round(haversine(exit, p) * 1.3 / paceMps * 1000));
}
