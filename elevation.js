// Track elevation: cumulative ascent/descent and values at a distance along the track.
// Uses the track's own elevations (never GPS altitude, which is too noisy on iPhone).

// Ascent/descent are counted with a hysteresis threshold: a climb or drop only
// counts once it exceeds the threshold, which removes small ups and downs that
// come from noisy GPS or DEM (Digital Elevation Model) data.
export const DEFAULT_ELEVATION_THRESHOLD_M = 5;

// Fill gaps in the elevation list by linear interpolation along the distance;
// null when the track has no elevation at all.
function fillElevations(points, cum) {
    const known = points.map((p, i) => (Number.isFinite(p.ele) ? i : -1)).filter((i) => i >= 0);
    if (known.length === 0) return null;
    const eles = new Array(points.length);
    let k = 0;
    for (let i = 0; i < points.length; i++) {
        while (k < known.length - 1 && known[k + 1] <= i) k++;
        const a = known[k], b = known[Math.min(k + 1, known.length - 1)];
        if (i <= a || a === b) eles[i] = points[i <= a ? a : b].ele;
        else {
            const t = (cum[i] - cum[a]) / ((cum[b] - cum[a]) || 1);
            eles[i] = points[a].ele + t * (points[b].ele - points[a].ele);
        }
    }
    return eles;
}

// track: result of buildTrack(). Returns null when there is no elevation data.
export function buildProfile(track, thresholdM = DEFAULT_ELEVATION_THRESHOLD_M) {
    const eles = fillElevations(track.points, track.cum);
    if (!eles) return null;

    const cumAscent = [0], cumDescent = [0];
    let anchor = eles[0], ascent = 0, descent = 0;
    for (let i = 1; i < eles.length; i++) {
        const diff = eles[i] - anchor;
        if (diff >= thresholdM) {
            ascent += diff;
            anchor = eles[i];
        } else if (-diff >= thresholdM) {
            descent -= diff;
            anchor = eles[i];
        }
        cumAscent.push(ascent);
        cumDescent.push(descent);
    }
    return {
        eles,
        cumAscent,
        cumDescent,
        totalAscent: ascent,
        totalDescent: descent,
        minEle: Math.min(...eles),
        maxEle: Math.max(...eles),
        thresholdM,
    };
}

// Elevation and ascent/descent done at `along` metres from the start.
export function profileAt(track, profile, along) {
    const { cum } = track;
    const d = Math.max(0, Math.min(track.total, along));
    let i = 0;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    const t = (d - cum[i]) / ((cum[i + 1] - cum[i]) || 1);
    const lerp = (arr) => arr[i] + t * (arr[i + 1] - arr[i]);
    return {
        ele: lerp(profile.eles),
        ascentDone: lerp(profile.cumAscent),
        descentDone: lerp(profile.cumDescent),
    };
}
