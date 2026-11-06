// Trail-guide importer screen (Plan): paste a club's milestone sheet or open a CSV,
// confirm, change or skip each place on the map, route between the confirmed ones
// and compare each leg with the sheet. Saves a normal Track Library entry with
// waypoints. The logic is in guide.js; search and routing are the app's own.

import {
    parseGuideText, parseGuideCsv, looksLikeCsv, chooseResult, regionsFrom, findPlace, cachedSearch, planFromLegs, compareLegs, placeWaypoints,
    hasContactDetails, METRES_PER_MILE, LEG_TOLERANCE,
} from './guide.js';
import { buildTrack } from './geo.js';
import { buildProfile } from './elevation.js';
import { buildGpx, gpxFileName } from './gpx.js';
import { densify } from './plan.js';
import { fillElevationsFromDem } from './dem-tiles.js';
import { routeBetween, routingAvailable, ROUTER_ATTRIBUTION } from './router.js';
import { searchPlaces, searchAvailable, GEOCODER_ATTRIBUTION } from './geocoder.js';

const TITLE_WORDS = [/guide/i, /hike/i, /trail/i]; // the best title for the track first
const MAX_TITLE_LENGTH = 90;

const STATUS_WORDS = { confirmed: 'Confirmed', suggested: 'Not confirmed yet', skipped: 'Skipped', searching: 'Searching…', none: 'Nothing found' };

// deps: { view, saveEntry(entry), exportGpx(text, name, title), toast(text, ms), settings,
//         formatDistance(m), formatDateTime(t), describe(track, profile), onChange(), onExit() }
export function createGuideImport(deps) {
    const { view, toast, settings, formatDistance } = deps;
    const $ = (id) => document.getElementById(id);

    let active = false;
    let dirty = false;      // something worth asking about before leaving
    let rows = [];          // per milestone: { mile, restroom, text, query, alternatives, status, results, choice, lat, lon, label, far, open }
    let current = -1;       // the row highlighted on the map
    let run = 0;            // bumped when a search or routing run is out of date
    const search = cachedSearch(searchPlaces); // reading a sheet again costs no quota
    let regions = [];       // state codes the sheet mentions, to narrow a search
    let built = null;       // the routed result: { plan, points, track, profile, waypoints, legs, filled, missing }

    const isPlace = (r) => r.status !== 'turn';
    const confirmed = () => rows.filter((r) => r.status === 'confirmed');
    const miles = (m) => (m / METRES_PER_MILE).toFixed(2);

    function showStep(step) {
        $('guide-step-sheet').hidden = step !== 'sheet';
        $('guide-step-places').hidden = step !== 'places';
        $('guide-step-result').hidden = step !== 'result';
        $('guide-panel').scrollTop = 0;
    }

    // Keeps the pins clear of the panel over the map's lower part.
    function fit(points) {
        if (!points.length) return;
        const bottom = Math.min($('guide-panel').offsetHeight, window.innerHeight * 0.6) + 30;
        view.fitTrack(points, { top: 40, left: 30, right: 30, bottom });
    }

    // ---------- Step 1: the sheet ----------

    function readSheet(text, fileName = '') {
        const csv = /\.csv$/i.test(fileName) || looksLikeCsv(text);
        const { milestones, ignored } = csv ? parseGuideCsv(text) : parseGuideText(text);
        if (milestones.length < 2) {
            toast('No milestones found: each one needs a line starting with its mileage.', 6000);
            return;
        }
        rows = milestones.map((m) => ({
            mile: m.mile,
            restroom: m.restroom,
            text: m.text,
            query: m.place?.query ?? '',
            alternatives: m.place?.alternatives ?? [],
            status: m.place ? 'searching' : 'turn',
            results: [],
            choice: -1,
            lat: null,
            lon: null,
            label: '',
            far: false,
            open: false,
        }));
        current = -1;
        dirty = true;
        regions = regionsFrom(milestones);
        const titles = ignored.filter((l) => l.length <= MAX_TITLE_LENGTH && !hasContactDetails(l));
        const title = TITLE_WORDS.map((words) => titles.find((l) => words.test(l))).find(Boolean);
        $('guide-name').value = title ?? fileName.replace(/\.\w+$/, '') ?? '';
        if (!$('guide-name').value) $('guide-name').value = `Trail guide ${deps.formatDateTime(Date.now())}`;
        $('guide-ignored-box').hidden = ignored.length === 0;
        $('guide-ignored-title').textContent = `${ignored.length} other line${ignored.length === 1 ? '' : 's'} ignored`;
        $('guide-ignored').replaceChildren(...ignored.map((l) => Object.assign(document.createElement('li'), { textContent: l })));
        showStep('places');
        render();
        searchAll();
    }

    $('guide-read').addEventListener('click', () => readSheet($('guide-text').value));
    $('guide-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = ''; // allow choosing the same file again
        if (!file) return;
        try {
            const text = await file.text();
            $('guide-text').value = text;
            readSheet(text, file.name);
        } catch (err) {
            console.error('Reading the guide failed:', err);
            toast('Could not read this file.', 5000);
        }
    });

    // ---------- Step 2: places ----------

    // The nearest place above this row that has a position.
    function previousPlaced(i) {
        for (let k = i - 1; k >= 0; k--) {
            if (rows[k].lat != null && rows[k].status !== 'skipped') return rows[k];
        }
        return null;
    }

    function applyResult(row, index, near, sheetM) {
        const place = row.results[index];
        row.choice = index;
        row.lat = place.lat;
        row.lon = place.lon;
        row.label = place.label;
        row.far = near ? !chooseResult([place], near, sheetM).plausible : false;
    }

    // Searches for a row: the name alone, then with each state the sheet mentions while
    // nothing found is possible for the sheet's distance from the place before. A result
    // that isn't possible is listed under Change but gets no pin, and doesn't count as
    // "the place before" for the next rows. Resolves false when searching should stop
    // (limit, no connection).
    async function searchRow(row, i) {
        const near = previousPlaced(i);
        const sheetM = near ? (row.mile - near.mile) * METRES_PER_MILE : 0;
        row.problem = '';
        const r = await findPlace(row.query, { near, focus: view.getCenter(), sheetM, regions, search });
        if (!r.ok) {
            row.status = 'none';
            row.lat = row.lon = null;
            row.problem = r.reason === 'limit' ? 'Search limit reached: try later.' : 'Place search unavailable right now (offline?).';
            return false;
        }
        row.results = r.results;
        if (r.index >= 0) {
            applyResult(row, r.index, near, sheetM);
            row.status = 'suggested';
            return true;
        }
        row.choice = -1;
        row.lat = row.lon = null;
        row.status = 'none';
        row.problem = r.results.length
            ? `No match near the route for “${row.query}”: Change to pick one or tap the map, or Skip.`
            : `Nothing found for “${row.query}”: Change to search or tap the map, or Skip.`;
        return true;
    }

    // After a place above changes: rows it had ruled out may fit now (no new searches).
    function recheckLater(from) {
        for (let k = from + 1; k < rows.length; k++) {
            const row = rows[k];
            if (row.status !== 'none' || !row.results.length) continue;
            const near = previousPlaced(k);
            const sheetM = near ? (row.mile - near.mile) * METRES_PER_MILE : 0;
            const { index, plausible } = chooseResult(row.results, near, sheetM, row.query);
            if (plausible) {
                applyResult(row, index, near, sheetM);
                row.status = 'suggested';
                row.problem = '';
            }
        }
    }

    // One at a time: the relay allows 30 requests a minute and each uses the shared quota.
    async function searchAll() {
        const mine = ++run;
        if (!searchAvailable()) {
            for (const r of rows) if (r.status === 'searching') { r.status = 'none'; r.problem = 'Place search is not set up.'; r.open = true; }
            render();
            return;
        }
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            if (row.status !== 'searching') continue;
            const ok = await searchRow(row, i);
            if (mine !== run || !active) return;
            if (!ok) {
                for (const r of rows) if (r.status === 'searching') { r.status = 'none'; r.problem = row.problem; }
                render();
                break;
            }
            render();
        }
        fit(rows.filter((r) => r.lat != null));
    }

    function select(i, { fly = true } = {}) {
        current = i;
        const row = rows[i];
        if (fly && row?.lat != null) view.jumpTo({ lat: row.lat, lon: row.lon });
        render();
    }

    function placedPins() {
        return rows.map((r, i) => ({ r, i })).filter(({ r }) => isPlace(r) && r.lat != null && r.status !== 'skipped');
    }

    function renderPins() {
        const pins = placedPins();
        view.setGuidePins(
            pins.map(({ r, i }) => ({ lat: r.lat, lon: r.lon, label: String(r.mile), status: r.status, active: i === current })),
            {
                onTap: (k) => {
                    const i = pins[k].i;
                    select(i, { fly: false });
                    $('guide-list').children[i]?.scrollIntoView({ block: 'nearest' });
                },
                onDrag: (k, p) => placeByHand(pins[k].i, p),
            },
        );
    }

    // Moved or tapped on the map: that's the user's own choice, so it counts as confirmed.
    function placeByHand(i, p) {
        const row = rows[i];
        Object.assign(row, { lat: p.lat, lon: p.lon, status: 'confirmed', choice: -1, label: 'Placed on the map', far: false, open: false, problem: '', query: row.query || row.text.slice(0, 40) });
        built = null;
        recheckLater(i);
        select(i, { fly: false });
    }

    function el(tag, props = {}, ...children) {
        const node = Object.assign(document.createElement(tag), props);
        node.append(...children);
        return node;
    }

    function button(text, onClick, className = '') {
        const b = el('button', { type: 'button', className, textContent: text });
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick();
        });
        return b;
    }

    function changePanel(row, i) {
        const input = el('input', { type: 'search', value: row.query, placeholder: 'Place to search for', enterKeyHint: 'search' });
        input.setAttribute('aria-label', `Search for mile ${row.mile}`);
        input.addEventListener('click', (e) => e.stopPropagation());
        const research = async () => {
            const text = input.value.trim();
            if (!text) return;
            row.query = text;
            row.status = 'searching';
            input.blur(); // so the list redraws: old results can't be picked during the search
            render();
            await searchRow(row, i);
            built = null;
            recheckLater(i);
            render();
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                research();
            }
        });
        const others = row.alternatives.map((name) => button(`Search “${name}”`, () => {
            input.value = name;
            research();
        }));
        const near = previousPlaced(i);
        const sheetM = near ? (row.mile - near.mile) * METRES_PER_MILE : 0;
        const results = row.status === 'searching' ? [] : row.results.map((p, k) => {
            const b = button('', () => {
                applyResult(row, k, near, sheetM);
                row.status = 'confirmed';
                row.problem = '';
                row.open = false;
                built = null;
                recheckLater(i);
                select(i);
            });
            b.append(p.label, el('small', { textContent: p.kind }));
            return b;
        });
        return el('div', { className: 'guide-change' }, input,
            button('Search', research),
            button('Tap the map to place it', () => {
                toast('Tap the place on the map.', 4000);
                view.pickPoint((p) => placeByHand(i, p));
            }),
            ...others, ...results);
    }

    function renderRow(row, i) {
        const restroom = row.restroom ? ' · restrooms' : '';
        const node = el('div', { className: `guide-row${isPlace(row) ? '' : ' turn'}${i === current ? ' active' : ''}` },
            el('span', { className: 'mile', textContent: `${row.mile}${row.restroom ? '*' : ''} ` }),
            `${row.text}`);
        node.addEventListener('click', () => select(i));

        if (!isPlace(row)) {
            node.append(el('div', { className: 'guide-row-actions' },
                button('Make it a place', () => {
                    row.status = 'none';
                    row.open = true;
                    row.query = row.alternatives[0] ?? '';
                    render();
                })));
            return node;
        }

        const words = row.status === 'suggested' || row.status === 'confirmed'
            ? `${STATUS_WORDS[row.status]}: ${row.label}` : row.problem || `${STATUS_WORDS[row.status]}: ${row.query}`;
        node.append(el('div', { className: `match${row.status === 'none' || row.far ? ' bad' : ''}`, textContent: words + restroom }));
        if (row.far) {
            node.append(el('div', { className: 'match bad', textContent: '⚠ Further from the place before than the sheet allows: probably the wrong place.' }));
        }
        node.append(el('div', { className: 'guide-row-actions' },
            button('Confirm', () => {
                if (row.lat == null) return toast('Nothing to confirm yet: search again or tap the map.');
                row.status = 'confirmed';
                built = null;
                render();
            }, row.status === 'confirmed' ? 'chosen' : ''),
            button('Change', () => {
                row.open = !row.open;
                current = i;
                render();
            }, row.open ? 'chosen' : ''),
            button('Skip', () => {
                row.status = 'skipped';
                row.open = false;
                built = null;
                recheckLater(i);
                render();
            }, row.status === 'skipped' ? 'chosen' : '')));
        if (row.open) node.append(changePanel(row, i));
        return node;
    }

    function render() {
        renderPins();
        const places = rows.filter(isPlace);
        const done = confirmed().length;
        const left = places.filter((r) => r.status === 'suggested').length;
        $('guide-summary').textContent = `${rows.length} milestones: ${places.length} places, ${rows.length - places.length} unnamed turns. ` +
            `${done} confirmed${left ? `, ${left} still to check` : ''}.`;
        const focused = document.activeElement;
        const keepTyping = focused?.closest?.('#guide-list') && focused.tagName === 'INPUT';
        if (!keepTyping) $('guide-list').replaceChildren(...rows.map(renderRow));
        $('guide-route').disabled = done < 2;
        $('guide-route').textContent = done < 2 ? 'Confirm at least two places' : `Route ${done} confirmed places`;
    }

    // ---------- Step 3: route, compare, save ----------

    async function routeConfirmed() {
        const mine = ++run;
        const anchors = confirmed();
        const anchorIndexes = rows.map((r, i) => (r.status === 'confirmed' ? i : -1)).filter((i) => i >= 0);
        built = null;
        showStep('result');
        $('guide-save').disabled = true;
        $('guide-export').disabled = true;
        $('guide-legs').replaceChildren();
        $('guide-waypoints').textContent = '';
        $('guide-notice').hidden = true;
        view.setGuidePins([]);

        const paths = [];
        const notes = [];
        let stop = !routingAvailable() ? 'Trail routing isn\'t set up yet: legs are drawn straight.' : '';
        for (let i = 0; i < anchors.length - 1; i++) {
            $('guide-total').textContent = `Finding trails: leg ${i + 1} of ${anchors.length - 1}…`;
            if (stop) {
                paths.push(null);
                continue;
            }
            const r = await routeBetween(anchors[i], anchors[i + 1]);
            if (mine !== run || !active) return;
            if (r.ok) {
                paths.push(r.path);
            } else {
                paths.push(null);
                if (r.reason === 'no-route') notes.push(`Mile ${anchors[i].mile}–${anchors[i + 1].mile}: no trail found, drawn straight.`);
                else stop = r.reason === 'limit' ? 'Routing limit reached: the other legs are drawn straight.' : 'Trail routing unavailable right now: the other legs are drawn straight.';
                if (r.detail) console.warn('Router:', r.reason, r.detail);
            }
        }
        if (stop) notes.push(stop);

        const plan = planFromLegs(anchors, paths);
        const lines = plan.segments.map((_, s) => plan.routes[s] ?? [plan.vertices[s], plan.vertices[s + 1]]);
        const legs = compareLegs(anchors.map((a) => a.mile), lines);
        const waypoints = placeWaypoints(rows.map(toMilestone), anchorIndexes, lines);
        const straight = new Set(plan.segments.map((t, s) => (t === 'straight' ? s : -1)).filter((s) => s >= 0));
        legs.forEach((leg, s) => { leg.straight = straight.has(s); });

        built = { plan, lines, legs, waypoints, anchors, points: null };
        // Flagged legs in orange, the same colour as the planner's warnings; no handles here.
        view.setPlan({
            vertices: plan.vertices,
            segments: plan.segments,
            lines,
            mids: lines.map(() => null),
            steep: new Set(legs.map((l, s) => (l.flagged ? s : -1)).filter((s) => s >= 0)),
            pending: new Set(),
        });
        view.setWaypoints(waypoints.map((w) => ({
            ...w,
            title: `Mile ${w.mile}${w.restroom ? ' · restrooms' : ''}`,
        })));
        fit(lines.flat());
        renderResult(notes);
        await addElevations(mine);
    }

    function toMilestone(r) {
        return { mile: r.mile, restroom: r.restroom, text: r.text, place: r.status === 'confirmed' ? { query: r.query } : null };
    }

    function renderResult(notes) {
        const { legs, anchors, waypoints } = built;
        const routeM = legs.reduce((m, l) => m + l.routeM, 0);
        const sheetM = (anchors.at(-1).mile - anchors[0].mile) * METRES_PER_MILE;
        const off = sheetM > 0 ? ((routeM - sheetM) / sheetM) * 100 : 0;
        const flagged = legs.filter((l) => l.flagged).length;
        $('guide-total').textContent = `Route ${miles(routeM)} mi, sheet ${miles(sheetM)} mi (${off >= 0 ? '+' : ''}${off.toFixed(1)}%). ` +
            (flagged ? `⚠ ${flagged} of ${legs.length} legs more than ${LEG_TOLERANCE * 100}% off: likely a shortcut or a wrong place.` : `All ${legs.length} legs within ${LEG_TOLERANCE * 100}%.`);
        $('guide-notice').hidden = notes.length === 0;
        $('guide-notice').textContent = notes.join(' ');

        const header = el('tr', {}, ...['Leg (sheet mi)', 'Sheet', 'Route', 'Diff'].map((t) => el('th', { textContent: t })));
        const body = legs.map((l) => el('tr', { className: l.flagged ? 'flagged' : '' },
            el('td', { textContent: `${l.flagged ? '⚠ ' : ''}${l.from} → ${l.to}${l.straight ? ' (straight)' : ''}` }),
            el('td', { textContent: miles(l.sheetM) }),
            el('td', { textContent: miles(l.routeM) }),
            el('td', { textContent: l.diffRatio == null ? '–' : `${l.diffRatio >= 0 ? '+' : ''}${(l.diffRatio * 100).toFixed(0)}%` })));
        $('guide-legs').replaceChildren(header, ...body);
        const restrooms = waypoints.filter((w) => w.restroom).length;
        $('guide-waypoints').textContent = `${waypoints.length} waypoints with notes, ${restrooms} with restrooms. ` +
            'Tap a marker on the map to read it. Orange legs are the flagged ones.';
    }

    // Elevations for the sampled line, then Save and Export are ready.
    async function addElevations(mine) {
        const points = densify(built.plan);
        let filled = points;
        try {
            const dem = await fillElevationsFromDem(points);
            if (dem) filled = dem.points;
        } catch (err) {
            console.error('DEM elevations failed:', err);
        }
        if (mine !== run || !active || !built) return;
        const missing = filled.filter((p) => !Number.isFinite(p.ele)).length;
        const track = { name: $('guide-name').value, ...buildTrack(filled) };
        built.points = filled;
        built.track = track;
        built.profile = buildProfile(track, settings.eleThresholdM);
        built.missing = missing;
        built.filled = filled.length - missing;
        $('guide-save').disabled = false;
        $('guide-export').disabled = false;
    }

    const trackName = () => $('guide-name').value.trim() || 'Trail guide';

    async function save() {
        if (!built?.points) return;
        $('guide-save').disabled = true;
        try {
            const name = trackName();
            await deps.saveEntry({
                id: `guide-${Date.now()}`,
                name,
                points: built.points.map(({ lat, lon, ele, straight }) => ({ lat, lon, ele, straight })),
                eleInfo: { own: 0, dem: built.filled, missing: built.missing, status: built.missing ? 'failed' : 'ok' },
                plan: built.plan,
                waypoints: built.waypoints,
                savedAt: Date.now(),
            });
            dirty = false;
            toast(`Saved “${name}” in the Track Library: load it there to follow it.`, 5000);
        } catch (err) {
            console.error('Saving the guide failed:', err);
            toast('Could not save the track on this device.', 5000);
        } finally {
            $('guide-save').disabled = false;
        }
    }

    // Straight from the tap (the Share sheet needs it).
    function exportTrack() {
        if (!built?.points) return;
        const name = trackName();
        const desc = deps.describe?.(built.track, built.profile) ?? '';
        deps.exportGpx(buildGpx({ name, desc, segments: [built.points], waypoints: built.waypoints }), gpxFileName(name), name);
    }

    // ---------- Open and close ----------

    function backToPlaces() {
        run++;
        view.setPlan({ vertices: [], segments: [], lines: [], mids: [], steep: new Set(), pending: new Set() });
        deps.onExit();
        showStep('places');
        render();
    }

    function open() {
        active = true;
        dirty = false;
        rows = [];
        built = null;
        $('guide-text').value = '';
        showStep('sheet');
        deps.onChange();
    }

    // Resolves false (and stays open) if there is unsaved work the user keeps.
    function close() {
        if (!active) return true;
        if (dirty && !confirm('Leave the trail-guide import without saving?')) return false;
        active = false;
        run++;
        rows = [];
        built = null;
        view.setGuidePins([]);
        view.stopPlanEditing();
        deps.onExit();
        deps.onChange();
        return true;
    }

    $('guide-cancel').addEventListener('click', () => close());
    $('guide-done').addEventListener('click', () => close());
    $('guide-back-sheet').addEventListener('click', () => {
        run++;
        view.setGuidePins([]);
        showStep('sheet');
    });
    $('guide-route').addEventListener('click', routeConfirmed);
    $('guide-save').addEventListener('click', save);
    $('guide-export').addEventListener('click', exportTrack);
    $('guide-back-places').addEventListener('click', backToPlaces);
    $('guide-credit').textContent = GEOCODER_ATTRIBUTION;
    $('guide-route-credit').textContent = ROUTER_ATTRIBUTION;

    return {
        open,
        close,
        get active() {
            return active;
        },
    };
}
