// Track planner screen (Stage 2): tap the map to add points, drag a point to
// move it, tap it to delete it, drag a segment's middle handle to insert a
// point, tap the handle to switch the segment between "trail" (follows paths,
// via the router) and "straight" (cross-country). Live totals and profile from
// the DEM, a warning where a straight segment crosses steep terrain, then save
// to Saved walks or export as GPX. Works with mouse and touch (see map-view.js).

import { buildTrack } from './geo.js';
import { buildProfile } from './elevation.js';
import { buildGpx, gpxFileName } from './gpx.js';
import {
    PlanEditor, SEGMENT_STRAIGHT, SEGMENT_TRAIL, MAX_DETOUR_RATIO, densify, slopeProbes, slopeFromProbes,
    steepSegments, planFromWalk, routeLine, midpoint,
} from './plan.js';
import { fillElevationsFromDem } from './dem-tiles.js';
import { routeBetween, routingAvailable, ROUTER_NAME, ROUTER_ATTRIBUTION } from './router.js';

const ELEVATION_DELAY_MS = 250; // after the last change, before asking the DEM

// "48° (111%)": slopes in degrees and as a grade (rise per 100 m).
export function slopeText(deg) {
    return `${Math.round(deg)}° (${Math.round(Math.tan(deg * Math.PI / 180) * 100)}%)`;
}

// What to tell the user when the router can't be used: the segments that needed
// it are drawn straight instead, so planning carries on.
const ROUTER_PROBLEMS = {
    limit: 'Routing limit reached: drawn straight. Tap a segment\'s middle circle later to try again.',
    unavailable: 'Trail routing unavailable right now: drawn straight. Tap a segment\'s middle circle to try again.',
};
const NOT_SET_UP = 'Trail routing isn\'t set up yet: segments are drawn straight.';

// deps: { view, chart, settings, saveEntry(entry), exportGpx(text, name, title),
//         toast(text, ms), formatDistance(m), formatMetres(m), formatDateTime(t), onExit() }
export function createPlanner(deps) {
    const { view, chart, settings, toast, formatDistance, formatMetres } = deps;
    const $ = (id) => document.getElementById(id);

    let editor = null;
    let entryId = null;      // the saved entry being edited (null: saving makes a new one)
    let dirty = false;
    let rev = 0;             // bumped on every change: results computed for an older rev are stale
    let result = null;       // last DEM result: { rev, points, track, profile, steep, filled, missing }
    let pending = null;      // Promise of the elevation run in progress
    let timer = null;
    let dragIndex = null;    // vertex being dragged after inserting it from a middle handle
    let nextType = SEGMENT_STRAIGHT; // type of the segment the next tap adds
    let notices = [];        // routing messages since the last edit
    let routing = false;     // a routing loop is running

    const upToDate = () => result && result.rev === rev;

    // ---------- Drawing and totals ----------

    function draw() {
        // Segment numbers change while editing: only highlight from a fresh result.
        const steep = new Set(upToDate() ? result.steep.map((s) => s.seg) : []);
        const lines = editor.segments.map((_, s) => editor.line(s));
        view.setPlan({
            vertices: editor.vertices,
            segments: editor.segments,
            lines,
            mids: lines.map(midpoint),
            steep,
            pending: new Set(editor.unrouted),
        });
        $('plan-undo').disabled = !editor.canUndo;
        $('plan-type').textContent = `Next: ${nextType === SEGMENT_TRAIL ? 'Trail' : 'Straight'}`;
        $('plan-type').classList.toggle('active', nextType === SEGMENT_TRAIL);
        renderTotals(lines);
    }

    function renderTotals(lines) {
        const n = editor.vertices.length;
        let summary;
        if (n === 0) summary = 'Tap the map to place the start';
        else if (n === 1) summary = 'Tap again to add the next point';
        else {
            const distance = lines.reduce((m, line) => m + buildTrack(line).total, 0);
            const profile = upToDate() ? result.profile : null;
            const climb = profile
                ? ` · ↑ ${formatMetres(profile.totalAscent)} · ↓ ${formatMetres(profile.totalDescent)}`
                : upToDate() ? ' · no elevation data (offline?)' : ' · ↑ … · ↓ …';
            summary = `${formatDistance(distance)}${climb} · ${n} points`;
        }
        $('trip-summary').textContent = summary;

        const warning = $('plan-warning');
        const steep = upToDate() ? result.steep : [];
        warning.hidden = steep.length === 0;
        if (steep.length) {
            const worst = Math.max(...steep.map((s) => s.maxDeg));
            const limit = slopeText(settings.steepSlopeDeg);
            warning.textContent = steep.length === 1
                ? `⚠ Straight segment ${steep[0].seg + 1} crosses slopes up to ${slopeText(worst)}; the warning starts at ${limit}. Shown in orange.`
                : `⚠ ${steep.length} straight segments cross slopes up to ${slopeText(worst)}; the warning starts at ${limit}. Shown in orange.`;
        }

        const status = routing ? [`Finding trails with ${ROUTER_NAME}…`] : [];
        $('plan-notice').textContent = [...status, ...notices].join(' ');
        $('plan-notice').hidden = status.length + notices.length === 0;
    }

    // ---------- Elevations from the DEM (debounced, latest change wins) ----------

    function scheduleElevations() {
        clearTimeout(timer);
        timer = setTimeout(computeElevations, ELEVATION_DELAY_MS);
    }

    function computeElevations() {
        clearTimeout(timer);
        if (editor.vertices.length < 2) {
            result = null;
            chart.setData(null, null);
            draw();
            return Promise.resolve(null);
        }
        const runRev = rev;
        const points = densify(editor.snapshot());
        // Terrain slope only matters on straight segments: four probes per point.
        const probed = points.map((p, i) => (p.straight ? i : -1)).filter((i) => i >= 0);
        const probes = probed.flatMap((i) => slopeProbes(points[i]));
        const run = fillElevationsFromDem([...points, ...probes]).catch((err) => {
            console.error('DEM elevations failed:', err);
            return null;
        }).then((dem) => {
            if (!editor) return null;
            // Changed meanwhile: answer with the newer run (start it if it is still
            // waiting for its timer). Returning this run itself would never settle.
            if (runRev !== rev) return pending !== run ? pending : computeElevations();
            const filled = dem ? dem.points.slice(0, points.length) : points;
            const slopes = new Array(points.length).fill(null);
            if (dem) {
                probed.forEach((i, k) => {
                    slopes[i] = slopeFromProbes(dem.points.slice(points.length + 4 * k, points.length + 4 * k + 4).map((p) => p.ele));
                });
            }
            const track = { name: $('plan-name').value, ...buildTrack(filled) };
            const profile = buildProfile(track, settings.eleThresholdM);
            const missing = filled.filter((p) => !Number.isFinite(p.ele)).length;
            result = {
                rev: runRev,
                points: filled,
                track,
                profile,
                steep: steepSegments(filled, slopes, settings.steepSlopeDeg),
                filled: filled.length - missing,
                missing,
            };
            chart.setData(track, profile);
            draw();
            return result;
        });
        pending = run;
        return run;
    }

    // A user edit: fresh messages, redraw, then trails and elevations.
    function changed({ final = true } = {}) {
        dirty = true;
        rev++;
        if (final) notices = [];
        draw();
        if (final) {
            scheduleElevations();
            routePending();
        }
    }

    // ---------- Trails from the router, one segment at a time ----------

    // Index of the segment from a to b now (the plan may have changed while waiting).
    function findSegment(a, b) {
        const same = (p, q) => p.lat === q.lat && p.lon === q.lon;
        return editor.segments.findIndex((t, s) => t === SEGMENT_TRAIL && !editor.routes[s] &&
            same(editor.vertices[s], a) && same(editor.vertices[s + 1], b));
    }

    // Any failure leaves a straight segment and a message: planning never breaks.
    async function routePending() {
        if (routing || !editor) return;
        routing = true;
        try {
            while (editor && editor.unrouted.length) {
                const s = editor.unrouted[0];
                const a = editor.vertices[s], b = editor.vertices[s + 1];
                draw();
                const r = await routeBetween(a, b);
                if (!editor) break;
                const t = findSegment(a, b);
                if (t < 0) continue; // moved meanwhile: the loop routes the new one
                if (r.ok) {
                    const route = routeLine(a, b, r.path);
                    if (route.line) {
                        editor.setRoute(t, route.line);
                    } else {
                        editor.fallBack(t);
                        notices.push(`Segment ${t + 1}: the trail would be ${route.ratio.toFixed(1)}× the straight distance ` +
                            `(${formatDistance(route.lengthM)} instead of ${formatDistance(route.straightM)}, more than ` +
                            `${MAX_DETOUR_RATIO}×), so it is drawn straight.`);
                    }
                } else if (r.reason === 'no-route') {
                    editor.fallBack(t);
                    notices.push(`Segment ${t + 1}: no trail found between these points, so it is drawn straight.`);
                } else {
                    // The router can't be used now: every waiting segment goes straight.
                    for (const u of editor.unrouted) editor.fallBack(u);
                    const note = !routingAvailable() ? NOT_SET_UP : ROUTER_PROBLEMS[r.reason] ?? ROUTER_PROBLEMS.unavailable;
                    if (!notices.includes(note)) notices.push(note);
                    if (r.detail) console.warn('Router:', r.reason, r.detail);
                }
                rev++;
                scheduleElevations();
            }
        } catch (err) {
            console.error('Routing failed:', err);
            if (editor) {
                for (const u of editor.unrouted) editor.fallBack(u);
                if (!notices.includes(ROUTER_PROBLEMS.unavailable)) notices.push(ROUTER_PROBLEMS.unavailable);
                rev++;
                scheduleElevations();
            }
        } finally {
            routing = false;
            if (editor) draw();
        }
    }

    // ---------- Map editing ----------

    const handlers = {
        add(p) {
            editor.append(p, nextType);
            changed();
        },
        tapVertex(i) {
            editor.remove(i);
            changed();
        },
        // Switch the segment between trail and straight.
        tapMid(s) {
            editor.setType(s, editor.segments[s] === SEGMENT_TRAIL ? SEGMENT_STRAIGHT : SEGMENT_TRAIL);
            changed();
        },
        dragVertex(i, p, phase) {
            if (phase === 'start') editor.checkpoint();
            editor.move(i, p);
            changed({ final: phase === 'end' });
        },
        dragMid(s, p, phase) {
            if (phase === 'start') dragIndex = editor.insert(s, p);
            else editor.move(dragIndex, p);
            changed({ final: phase === 'end' });
        },
    };

    function undo() {
        if (!editor.undo()) return;
        changed();
    }

    document.addEventListener('keydown', (e) => {
        if (!editor || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
        if (e.target instanceof HTMLInputElement) return; // the name field has its own undo
        e.preventDefault();
        undo();
    });

    // ---------- Open, save, export, close ----------

    // entry: a Saved walks entry to edit, or nothing for a new track. A planned
    // track is edited as drawn; a recorded walk is simplified to points on
    // "trail" segments that keep the walked path (no routing needed) and saved
    // as a new entry, so the recording itself is kept.
    function open(entry = null) {
        if (entry?.plan) {
            // Plans saved before routing existed have no routes: keep their
            // trail segments as drawn rather than routing them all at once.
            const { vertices, segments } = entry.plan;
            const routes = entry.plan.routes ?? segments.map((t, i) => (t === SEGMENT_TRAIL ? [vertices[i], vertices[i + 1]] : null));
            editor = new PlanEditor({ vertices, segments, routes });
            entryId = entry.id;
            $('plan-name').value = entry.name;
        } else if (entry) {
            editor = new PlanEditor(planFromWalk(entry.points));
            entryId = null;
            $('plan-name').value = `${entry.name} (edited)`;
        } else {
            editor = new PlanEditor();
            entryId = null;
            $('plan-name').value = `Track ${deps.formatDateTime(Date.now())}`;
        }
        nextType = routingAvailable() ? SEGMENT_TRAIL : SEGMENT_STRAIGHT;
        dirty = false;
        result = null;
        notices = routingAvailable() ? [] : [NOT_SET_UP];
        rev++;
        document.body.classList.add('plan-mode');
        view.startPlanEditing(handlers);
        if (editor.vertices.length) view.fitTrack(editor.vertices);
        chart.setData(null, null);
        draw();
        computeElevations();
    }

    async function save() {
        if (editor.vertices.length < 2) return toast('Add at least two points first.');
        if (routing) return toast('Still finding trails: save in a moment.');
        const name = $('plan-name').value.trim() || 'Planned track';
        $('plan-save').disabled = true;
        try {
            const r = upToDate() ? result : await computeElevations();
            const entry = {
                id: entryId ?? `plan-${Date.now()}`,
                name,
                points: r.points.map(({ lat, lon, ele, straight }) => ({ lat, lon, ele, straight })),
                eleInfo: { own: 0, dem: r.filled, missing: r.missing, status: r.missing ? 'failed' : 'ok' },
                plan: editor.snapshot(),
                savedAt: Date.now(),
            };
            await deps.saveEntry(entry);
            entryId = entry.id;
            dirty = false;
            toast(`Saved “${name}” in Settings › Saved walks: load it there to follow it.`, 5000);
        } catch (err) {
            console.error('Saving planned track failed:', err);
            toast('Could not save the track on this device.', 5000);
        } finally {
            $('plan-save').disabled = false;
        }
    }

    // Straight from the tap (the Share sheet needs it), so it uses the elevations
    // already computed.
    function exportPlan() {
        if (editor.vertices.length < 2) return toast('Add at least two points first.');
        if (routing || !upToDate()) {
            computeElevations();
            return toast('Trails and elevations are still loading: try again in a moment.');
        }
        const name = $('plan-name').value.trim() || 'Planned track';
        deps.exportGpx(buildGpx({ name, segments: [result.points] }), gpxFileName(name), name);
    }

    function close() {
        if (dirty && !confirm('Leave the planner without saving your changes?')) return;
        clearTimeout(timer);
        rev++;
        editor = null;
        result = null;
        document.body.classList.remove('plan-mode');
        view.stopPlanEditing();
        deps.onExit();
    }

    $('plan-undo').addEventListener('click', undo);
    $('plan-type').addEventListener('click', () => {
        nextType = nextType === SEGMENT_TRAIL ? SEGMENT_STRAIGHT : SEGMENT_TRAIL;
        draw();
    });
    $('plan-save').addEventListener('click', save);
    $('plan-export').addEventListener('click', exportPlan);
    $('plan-done').addEventListener('click', close);
    $('plan-name').addEventListener('input', () => { if (editor) dirty = true; });
    $('plan-credit').textContent = ROUTER_ATTRIBUTION;

    return {
        open,
        get active() {
            return editor !== null;
        },
        // A setting that affects the totals or the warning changed.
        refresh() {
            if (!editor) return;
            rev++;
            computeElevations();
        },
    };
}
