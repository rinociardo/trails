// Fills recording gaps in the background (see gaps.js for the rules): asks the
// router for up to 3 routes when the gap needs one, and gives the options their
// elevations from the DEM. Never asks the user anything; a gap that can't be
// filled now (no signal, limit reached) stays a straight line marked "to be filled"
// and is tried again later (retry()).

import { routeAlternatives } from './router.js';
import { fillElevationsFromDem } from './dem-tiles.js';
import { routeOptions, straightOption } from './gaps.js';

const busy = new Set(); // gap ids being filled now

const needsElevations = (gap) => gap.options.some((o) => o.points.some((p) => !Number.isFinite(p.ele)));
export const needsWork = (gap) => gap.status === 'pending' || needsElevations(gap);

// Fills one gap (changing it in place). Resolves true if anything changed.
export async function fillGap(gap) {
    if (busy.has(gap.id) || !needsWork(gap)) return false;
    busy.add(gap.id);
    let changed = false;
    try {
        if (gap.status === 'pending') {
            const r = await routeAlternatives(gap.from, gap.to);
            const straight = straightOption(gap.from, gap.to, gap.durationMs);
            if (r.ok) {
                const { options, chosen } = routeOptions(r.paths, {
                    from: gap.from, to: gap.to, durationMs: gap.durationMs, paceMps: gap.paceMps, maxSpeedMps: gap.maxSpeedMps,
                });
                if (options.length) {
                    Object.assign(gap, { status: 'filled', source: 'route', options: [...options, straight], chosen });
                } else {
                    Object.assign(gap, { status: 'guess', source: 'straight', options: [straight], chosen: 0,
                        note: `${r.paths.length === 1 ? 'the trail route was' : `all ${r.paths.length} trail routes were`} too long or too fast for walking` });
                }
                changed = true;
            } else if (r.reason === 'no-route') {
                Object.assign(gap, { status: 'guess', source: 'straight', options: [straight], chosen: 0, note: 'no trail found' });
                changed = true;
            } else {
                gap.note = r.reason === 'limit' ? 'routing limit reached: filled later' : 'no signal: filled when back online';
            }
        }
        for (const option of gap.options) {
            if (!option.points.some((p) => !Number.isFinite(p.ele))) continue;
            try {
                const result = await fillElevationsFromDem(option.points);
                if (result.filled) {
                    option.points = result.points;
                    changed = true;
                }
            } catch {
                // No DEM now (offline): tried again later.
            }
        }
    } finally {
        busy.delete(gap.id);
    }
    return changed;
}
