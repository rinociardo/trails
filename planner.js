// Track planner screen (Stage 2, step 1): tap the map to add points joined by
// straight lines, drag a point to move it, tap it to delete it, drag a
// segment's middle handle to insert a point. Live totals and profile from the
// DEM, a warning where a straight segment crosses steep terrain, then save to
// Saved walks or export as GPX. Works with mouse and touch (see map-view.js).

import { buildTrack } from './geo.js';
import { buildProfile } from './elevation.js';
import { buildGpx, gpxFileName } from './gpx.js';
import { PlanEditor, SEGMENT_STRAIGHT, SEGMENT_TRAIL, densify, slopeProbes, slopeFromProbes, steepSegments, simplify } from './plan.js';
import { fillElevationsFromDem } from './dem-tiles.js';

const ELEVATION_DELAY_MS = 250; // after the last change, before asking the DEM
const WALK_SIMPLIFY_M = 3;      // a recorded walk becomes points this close to its line

// deps: { view, chart, settings, saveEntry(entry), exportGpx(text, name, title),
//         toast(text, ms), formatDistance(m), formatMetres(m), formatDateTime(t), onExit() }
export function createPlanner(deps) {
    const { view, chart, settings, toast, formatDistance, formatMetres } = deps;
    const $ = (id) => document.getElementById(id);

    let editor = null;
    let entryId = null;      // the saved entry being edited (null: saving makes a new one)
    let dirty = false;
    let result = null;       // last DEM result: { key, points, track, profile, steep, filled, missing }
    let pending = null;      // Promise of the elevation run in progress
    let runId = 0;
    let timer = null;
    let dragIndex = null;    // vertex being dragged after inserting it from a middle handle

    const key = () => JSON.stringify(editor.snapshot());
    const upToDate = () => result && result.key === key();

    // ---------- Drawing and totals ----------

    function draw() {
        // Segment numbers change while editing: only highlight from a fresh result.
        const steep = new Set(upToDate() ? result.steep.map((s) => s.seg) : []);
        view.setPlan({ vertices: editor.vertices, segments: editor.segments, steep });
        $('plan-undo').disabled = !editor.canUndo;
        renderTotals();
    }

    function renderTotals() {
        const n = editor.vertices.length;
        let summary;
        if (n === 0) summary = 'Tap the map to place the start';
        else if (n === 1) summary = 'Tap again to add the next point';
        else {
            const distance = buildTrack(editor.vertices).total;
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
            const worst = Math.round(Math.max(...steep.map((s) => s.maxDeg)));
            warning.textContent = steep.length === 1
                ? `⚠ Straight segment ${steep[0].seg + 1} crosses slopes up to ${worst}° (warning above ${settings.steepSlopeDeg}°), shown in orange.`
                : `⚠ ${steep.length} straight segments cross slopes steeper than ${settings.steepSlopeDeg}° (up to ${worst}°), shown in orange.`;
        }
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
        const id = ++runId;
        const runKey = key();
        const snapshot = editor.snapshot();
        const points = densify(snapshot);
        // Terrain slope only matters on straight segments: four probes per point.
        const probed = points.map((p, i) => (p.straight ? i : -1)).filter((i) => i >= 0);
        const probes = probed.flatMap((i) => slopeProbes(points[i]));
        pending = fillElevationsFromDem([...points, ...probes]).catch((err) => {
            console.error('DEM elevations failed:', err);
            return null;
        }).then((dem) => {
            if (id !== runId) return pending; // a newer change is being computed
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
                key: runKey,
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
        return pending;
    }

    function changed({ elevations = true } = {}) {
        dirty = true;
        draw();
        if (elevations) scheduleElevations();
    }

    // ---------- Map editing ----------

    const handlers = {
        add(p) {
            editor.append(p, SEGMENT_STRAIGHT); // step 1: no routing yet, every segment is straight
            changed();
        },
        tapVertex(i) {
            editor.remove(i);
            changed();
        },
        dragVertex(i, p, phase) {
            if (phase === 'start') editor.checkpoint();
            editor.move(i, p);
            changed({ elevations: phase === 'end' });
        },
        dragMid(s, p, phase) {
            if (phase === 'start') dragIndex = editor.insert(s, p);
            else editor.move(dragIndex, p);
            changed({ elevations: phase === 'end' });
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
    // "trail" segments (it followed real paths) and saved as a new entry, so the
    // recording itself is kept.
    function open(entry = null) {
        if (entry?.plan) {
            editor = new PlanEditor(entry.plan);
            entryId = entry.id;
            $('plan-name').value = entry.name;
        } else if (entry) {
            const vertices = simplify(entry.points, WALK_SIMPLIFY_M);
            editor = new PlanEditor({ vertices, segments: vertices.slice(1).map(() => SEGMENT_TRAIL) });
            entryId = null;
            $('plan-name').value = `${entry.name} (edited)`;
        } else {
            editor = new PlanEditor();
            entryId = null;
            $('plan-name').value = `Track ${deps.formatDateTime(Date.now())}`;
        }
        dirty = false;
        result = null;
        document.body.classList.add('plan-mode');
        view.startPlanEditing(handlers);
        if (editor.vertices.length) view.fitTrack(editor.vertices);
        chart.setData(null, null);
        draw();
        computeElevations();
    }

    async function save() {
        if (editor.vertices.length < 2) return toast('Add at least two points first.');
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
        if (!upToDate()) {
            computeElevations();
            return toast('Elevations are still loading: try again in a moment.');
        }
        const name = $('plan-name').value.trim() || 'Planned track';
        deps.exportGpx(buildGpx({ name, segments: [result.points] }), gpxFileName(name), name);
    }

    function close() {
        if (dirty && !confirm('Leave the planner without saving your changes?')) return;
        clearTimeout(timer);
        runId++;
        editor = null;
        result = null;
        document.body.classList.remove('plan-mode');
        view.stopPlanEditing();
        deps.onExit();
    }

    $('plan-undo').addEventListener('click', undo);
    $('plan-save').addEventListener('click', save);
    $('plan-export').addEventListener('click', exportPlan);
    $('plan-done').addEventListener('click', close);
    $('plan-name').addEventListener('input', () => { if (editor) dirty = true; });

    return {
        open,
        get active() {
            return editor !== null;
        },
        // A setting that affects the totals or the warning changed.
        refresh() {
            if (editor) computeElevations();
        },
    };
}
