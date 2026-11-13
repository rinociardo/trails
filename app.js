import { buildTrack, locateOnTrack, pointAtDistance, haversine } from './geo.js';
import { parseGpx, buildGpx, gpxFileName, NO_ELEVATION_DESC } from './gpx.js';
import { buildProfile, profileAt, DEFAULT_ELEVATION_THRESHOLD_M } from './elevation.js';
import { PositionSmoother, MotionTracker, PathRecorder, DEFAULT_TRACKING, trimToWindow, elevationRange } from './tracker.js';
import { createMapView } from './map-view.js';
import { createProfileChart } from './profile-chart.js';
import { TERRAIN, DEMO_TERRAIN } from './map-config.js';
import { fillElevationsFromDem, elevationAt, demStoreCount, clearDemStore, DEM_NAME, DEM_CREDITS } from './dem-tiles.js';
import { GAP_MIN_MS, DEFAULT_GAP_MAX_SPEED_MPS, gapPlan, straightOption, paceBefore, gapTotals, gapNumbers, gapPathPoints, splitGaps, replaceGapPoints } from './gaps.js';
import { fillGap, needsWork } from './gap-fill.js';
import { PauseWatcher, DEFAULT_PAUSE_RADIUS_M, walkedUnseenMs } from './pause.js';
import { parseCoordinates, formatCoordinates } from './coords.js';
import { editWalk, snapPlan, cumulative, entryKind, withNewVersion, restoreVersion, libraryLinks } from './walk-edit.js';
import { ClimbCounter, WalkRates, OffTrackDetector, averageRates, walkSnapshot, restoreWalk, nextAlertMode, LEVEL_MPS, SPEED_WINDOW_MS } from './walk.js';
import { createPlanner } from './planner.js';
import { createGuideImport } from './guide-import.js';
import { locateWaypoints, nextWaypoint } from './guide.js';
import { ROUTER_ATTRIBUTION, routingAvailable } from './router.js';
import { searchPlaces, searchAvailable, GEOCODER_ATTRIBUTION } from './geocoder.js';
import { makeUnits, defaultUnitSystem } from './units.js';

// Developer switches: ?sim (or ?sim=N for N× walking speed, default 10) replays
// the loaded track with GPS noise, a stop and a detour; ?terrain=demo previews
// 3D terrain with MapLibre's demo elevation tiles.
const params = new URLSearchParams(location.search);
const terrain = params.get('terrain') === 'demo' ? DEMO_TERRAIN : TERRAIN;

const DEFAULT_CENTER = { lat: 40.5, lon: 18.0 };
const ALERT_REPEAT_MS = 60_000;
const STALE_FIX_MS = 30_000;
const DEBUG_HISTORY = 60;           // fixes kept for the debug view
const WALKED_REDRAW_MS = 5000;      // the walked line is redrawn at most this often
const SETTINGS_KEY = 'trails.settings';
const DEFAULT_SETTINGS = {
    offTrackM: 50,
    offTrackStraightM: 100, // on straight (cross-country) segments of a planned track
    alertMode: 'banner',    // off-track alert: 'off', 'banner' (banner only) or 'sound' (banner + sound)
    vSpeedPer: 'h',         // vertical speed per hour, 'min' or 's'
    profileShows: 'track',  // Go with a track: the profile of the 'track' or of 'walk' (my walk)
    gapMaxSpeedMps: DEFAULT_GAP_MAX_SPEED_MPS, // recording gaps: routes implying a faster walk are dropped
    pauseRadiusM: DEFAULT_PAUSE_RADIUS_M,       // Smart Pause zone
    autoDimS: 60,
    maxAccuracyM: DEFAULT_TRACKING.maxAccuracyM,
    smoothWindow: DEFAULT_TRACKING.windowSize,
    stopRadiusM: DEFAULT_TRACKING.stopRadiusM,
    stopTimeS: DEFAULT_TRACKING.stopTimeS,
    stopClimbM: DEFAULT_TRACKING.stopClimbM,
    eleThresholdM: DEFAULT_ELEVATION_THRESHOLD_M,
    steepSlopeDeg: 20,      // planner: warn when a straight segment crosses steeper terrain (≈36%)
    debug: false,
    simulate: false,
    panelOpen: true,
    units: defaultUnitSystem(navigator.language), // 'metric' or 'imperial'
    tab: 'explore',         // the tab shown last
};

const $ = (id) => document.getElementById(id);

// ---------- Settings (small, so localStorage is fine) ----------

function loadSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
        // v0.8.0 lowered the steep-slope default from 30° to 20°: move the old default along.
        if (!stored.steepDefault20) {
            if (stored.steepSlopeDeg === 30) delete stored.steepSlopeDeg;
            stored.steepDefault20 = true;
        }
        // v0.12.0 replaced "Sound with off-track alert" (on by default) with a choice
        // whose default is Banner only: no sound unless chosen again.
        if (!('alertMode' in stored)) delete stored.sound;
        // v0.9.0 routes through the Trails relay: forget any personal key entered in v0.8.0.
        delete stored.orsKey;
        return { ...DEFAULT_SETTINGS, ...stored };
    } catch {
        return { ...DEFAULT_SETTINGS };
    }
}

function saveSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // Storage unavailable (e.g. private mode): settings last for this session only.
    }
}

const settings = loadSettings();
let units = makeUnits(settings.units);

// Simulated GPS: ?sim in the address, or Settings › Testing (needed for the Home
// Screen app, which always opens the plain address).
const SIMULATE = params.has('sim') || settings.simulate;
const SIM_SPEEDUP = Math.max(1, Number(params.get('sim')) || 10);

// ---------- Track storage (IndexedDB: GPX tracks can be large) ----------

function idb(mode, action) {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('trails-app', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            try {
                const tx = db.transaction('kv', mode);
                const request = action(tx.objectStore('kv'));
                tx.oncomplete = () => { db.close(); resolve(request.result); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            } catch (err) {
                db.close();
                reject(err);
            }
        };
    });
}

const kvGet = (key) => idb('readonly', (store) => store.get(key));
const kvSet = (key, value) => idb('readwrite', (store) => store.put(value, key));
const kvDelete = (key) => idb('readwrite', (store) => store.delete(key));

// Ask the browser not to evict our data when space runs low.
function requestPersistence() {
    navigator.storage?.persist?.().catch(() => {});
}

// ---------- Small UI helpers ----------

function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
}

function setStatus(el, text, tone = '') {
    setText(el, text);
    el.classList.toggle('ok', tone === 'ok');
    el.classList.toggle('warn', tone === 'warn');
}

// In the chosen units (Settings › Units); values stay in metres inside the app.
function formatDistance(m) {
    return units.distance(m);
}

// Elevations, climbs, accuracies: m or ft.
function formatMetres(m, decimals = 0) {
    return units.length(m, decimals);
}

// Local date and time, e.g. "2026-10-28 15:40".
function formatDateTime(time) {
    const d = new Date(time);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Totals in the chosen units, for the description inside exported GPX files
// (the points themselves are in metres, as the GPX standard requires).
function totalsText(t, profile) {
    const parts = [`Distance ${formatDistance(t.total)}`];
    if (profile) parts.push(`ascent ${formatMetres(profile.totalAscent)}`, `descent ${formatMetres(profile.totalDescent)}`);
    return parts.join(', ');
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

let toastTimer = null;
function toast(message, ms = 3000) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// The map fills the space between the top bar and the trip panel + bottom bar.
function updateLayout() {
    const root = document.documentElement.style;
    root.setProperty('--stats-h', `${$('stats').offsetHeight}px`);
    root.setProperty('--panel-h', `${$('trip-panel').offsetHeight}px`);
    root.setProperty('--bottom-h', `${$('bottom').offsetHeight}px`);
}
$('trip-panel').classList.toggle('collapsed', !settings.panelOpen);
$('trip-toggle').setAttribute('aria-expanded', String(settings.panelOpen));
updateLayout();
const layoutObserver = new ResizeObserver(updateLayout);
layoutObserver.observe($('stats'));
layoutObserver.observe($('trip-panel'));
layoutObserver.observe($('bottom'));

$('trip-toggle').addEventListener('click', () => {
    settings.panelOpen = !settings.panelOpen;
    saveSettings();
    $('trip-panel').classList.toggle('collapsed', !settings.panelOpen);
    $('trip-toggle').setAttribute('aria-expanded', String(settings.panelOpen));
});

// ---------- Map ----------

// The demo elevation tiles only cover Innsbruck, so the preview opens there, tilted.
const startView = terrain === DEMO_TERRAIN
    ? { center: { lat: 47.27, lon: 11.39 }, zoom: 12, pitch: 60 }
    : { center: DEFAULT_CENTER, zoom: 11, pitch: 0 };
const view = createMapView({ container: 'map', ...startView, terrain });

view.on('webglcontextlost', () => {
    toast('The map display was reset by the phone. It should redraw by itself.', 6000);
});

const chart = createProfileChart($('profile'), { getUnits: () => units });

const planner = createPlanner({
    view,
    chart,
    settings,
    // Saving over a saved track keeps its earlier version (Track Library › Restore).
    saveEntry: (entry) => saveLibraryEntry(entry, { keepVersion: 'edited in Plan' }),
    exportGpx,
    toast,
    formatDistance,
    formatMetres,
    formatDateTime,
    describe: totalsText,
    onOpen: updateChrome,
    // Back to the loaded track's profile (or the walk's) and numbers, and the Plan start card.
    onExit() {
        showProfile();
        updateChrome();
    },
});

const guideImport = createGuideImport({
    view,
    saveEntry: saveLibraryEntry,
    exportGpx,
    toast,
    settings,
    formatDistance,
    formatDateTime,
    describe: totalsText,
    onChange() {
        document.body.classList.toggle('guide-mode', guideImport.active);
        updateChrome();
    },
    // Back to the loaded track's waypoints.
    onExit() {
        renderWaypoints();
    },
});

// ---------- State ----------

// { name, points, cum, total, profile, eleInfo, temporary, waypoints }: profile is null without
// elevations; eleInfo counts where they came from (see elevationText); temporary
// marks the test loop, which is not brought back on reopening.
let track = null;

const smoother = new PositionSmoother({ maxAccuracyM: settings.maxAccuracyM, windowSize: settings.smoothWindow });
const motion = new MotionTracker({ stopRadiusM: settings.stopRadiusM, stopTimeS: settings.stopTimeS, stopClimbM: settings.stopClimbM });
const path = new PathRecorder(); // the hike as walked, for GPX export
const climb = new ClimbCounter(settings.eleThresholdM); // ascent/descent of the walk, from the DEM
const rates = new WalkRates();   // current speed, vertical speed, time climbing/descending
// Off the track, for the numbers and the alert alike: 2 far fixes in a row
// (filters GPS jumps), back inside 80% of the limit to clear.
const offTrack = new OffTrackDetector({ confirmFixes: 2, backRatio: 0.8 });
// Recording gaps (no fix for 20 s or more while hiking), filled by guessing the way (gaps.js).
let gaps = [];

// Smart Pause (pause.js): the watcher while paused, else null.
let pauseWatch = null;

// The walk's totals: what was recorded plus the filled gaps; paused time apart.
function walkTotals(now = Date.now()) {
    const g = gapTotals(gaps, settings.eleThresholdM);
    return {
        pausedMs: hike.pausedMs + (pauseWatch ? Math.max(0, now - pauseWatch.since) : 0),
        walked: motion.walked + g.walked,
        movingMs: motion.movingMs + g.movingMs,
        stoppedMs: motion.stoppedMs + g.stoppedMs,
        ascent: climb.ascent + g.ascent,
        descent: climb.descent + g.descent,
    };
}

const hike = {
    running: false,
    watchId: null,
    simTimer: null,
    clockTimer: null,
    lastFix: null,      // position shown on the map: { lat, lon, acc }
    lastFixAt: 0,
    prevAlong: 0,
    progress: null,     // { along, offset } from the snapped, smoothed position
    offTrack: false,
    alertOverride: null, // Go › Alerts: this hike's alert mode, when not the one in Settings
    ele: {},            // DEM elevation here: { ele } or { status: 'loading' | 'unavailable' }
    lastGood: null,     // last accepted position while hiking { lat, lon, time, ele, along, onTrack }: where a gap starts
    gapMark: null,      // the next recorded point is the first after this gap
    gapToFill: null,
    continueSegment: false, // Resume after a force-close: the closed time is a gap, not a new segment
    pausedMs: 0,        // time paused (Go › Pause), finished pauses
    undo: null,         // what an automatic resume changed, for Undo
    simHoldUntil: 0,    // simulation: stand still (a picnic) after Pause
    lastAlertAt: 0,
    dimmed: false,
    savedPoints: 0,     // path.pointCount when the walk was last exported or saved as a track
    walkId: null,       // this recording's walk in the Track Library (saved on every Stop)
};

// Recent fixes for the debug view.
const debug = {
    raw: [],            // { lat, lon, acc, accepted, time }
    smooth: [],         // { lat, lon, acc, count }
    discarded: 0,
    lastInterval: null, // ms between the last two raw fixes
    eles: [],           // { time, ele }: track elevation at the snapped position, last stop-time window
};

// ---------- Rendering ----------

// Off the track (same limits and hysteresis as the alert): remaining shows "—"
// and "Off track: N m to the track" instead, whatever the alert setting.
const isOffTrack = () => Boolean(track) && hike.offTrack;

function renderStats() {
    const p = hike.progress;
    const off = isOffTrack();
    const done = track && p ? p.along : null;
    const remaining = track ? track.total - (p ? p.along : 0) : null;
    const offset = track && p ? p.offset : null;

    const doneText = done == null ? '–' : formatDistance(done);
    const remainingText = off ? '—' : remaining == null ? '–' : formatDistance(remaining);
    const offsetText = formatDistance(offset);

    setText($('stat-done'), doneText);
    setText($('stat-remaining'), remainingText);
    setText($('stat-offset'), offsetText);
    setText($('stat-offset-label'), off ? 'Off track' : 'From track');
    setText($('dim-done'), doneText);
    setText($('dim-remaining'), remainingText);
    setText($('dim-offset'), offsetText);
    setText($('dim-offset-label'), off ? 'Off track' : 'From track');

    $('stat-offset').classList.toggle('alert', off);
    $('dim-overlay').classList.toggle('off-track', off);
    $('off-track-line').hidden = !off;
    if (off) setText($('off-track-line'), `Off track: ${offsetText} to the track`);
    $('alert-banner').hidden = !off || alertMode() === 'off';
    if (off) setText($('alert-distance'), `${offsetText} from route`);

    renderNextWaypoint();
    renderTrip();
}

// The track's waypoints as markers on the map.
function renderWaypoints() {
    view.setWaypoints((track?.waypoints ?? []).map((w) => ({
        ...w,
        title: `${w.name || (Number.isFinite(w.mile) ? `Mile ${w.mile}` : 'Waypoint')}${w.restroom ? ' · restrooms' : ''}`,
    })));
}

// "In 0.25 mi: Turn left…", on the hike screen and the dim screen. Only redrawn when
// its text changes, so a GPS fix costs next to nothing.
function renderNextWaypoint() {
    const box = $('next-waypoint'), dim = $('dim-next');
    const next = track ? nextWaypoint(track.waypoints, hike.progress?.along ?? 0) : null;
    const showing = Boolean(next) && !planner.active;
    box.hidden = !showing;
    dim.hidden = !showing;
    if (!showing) {
        box.dataset.text = '';
        return;
    }
    const { waypoint: w, distance } = next;
    const note = w.note || w.name || 'Waypoint';
    const distanceText = `In ${formatDistance(distance)}`;
    const key = `${distanceText}|${note}|${w.restroom}`;
    if (box.dataset.text === key) return;
    box.dataset.text = key;
    const parts = [Object.assign(document.createElement('b'), { textContent: `${distanceText}${w.restroom ? ' · restrooms ' : ''}` })];
    if (w.restroom) {
        const icon = document.createElement('span');
        icon.innerHTML = '<svg class="restroom-icon" aria-hidden="true"><use href="#icon-restroom"/></svg>';
        parts.push(icon);
    }
    parts.push(Object.assign(document.createElement('div'), { className: 'note', textContent: note }));
    box.replaceChildren(...parts);
    setText(dim, `${distanceText}: ${note}`);
}

$('next-waypoint').addEventListener('click', () => $('next-waypoint').classList.toggle('open'));

// Done / remaining / total table and the profile marker. Totals show as soon
// as a track is loaded, so trails can be compared before starting.
function renderTrip() {
    if (planner.active) return; // the planner shows its own totals and profile
    const prof = track?.profile;
    const along = hike.progress?.along ?? 0;
    const started = Boolean(track && hike.progress);
    const done = (v) => (started ? v : '–');
    const off = isOffTrack();
    const rem = (v) => (off ? '—' : v);

    setText($('t-dist-done'), done(formatDistance(along)));
    setText($('t-dist-rem'), track ? rem(formatDistance(track.total - along)) : '–');
    setText($('t-dist-total'), track ? formatDistance(track.total) : '–');

    const at = prof ? profileAt(track, prof, along) : null;
    setText($('t-asc-done'), prof ? done(formatMetres(at.ascentDone)) : '–');
    setText($('t-asc-rem'), prof ? rem(formatMetres(prof.totalAscent - at.ascentDone)) : '–');
    setText($('t-asc-total'), prof ? formatMetres(prof.totalAscent) : '–');
    setText($('t-desc-done'), prof ? done(formatMetres(at.descentDone)) : '–');
    setText($('t-desc-rem'), prof ? rem(formatMetres(prof.totalDescent - at.descentDone)) : '–');
    setText($('t-desc-total'), prof ? formatMetres(prof.totalDescent) : '–');
    setText($('dim-climb'), prof ? rem(formatMetres(prof.totalAscent - at.ascentDone)) : '–');

    let summary = 'No track · Start records your walk';
    if (track) {
        summary = prof
            ? `${formatDistance(track.total)} · ↑ ${formatMetres(prof.totalAscent)} · ↓ ${formatMetres(prof.totalDescent)}`
            : `${formatDistance(track.total)} · no elevation data`;
    }
    setText($('trip-summary'), summary);
    setText($('track-info'), track ? elevationText(track) : '');
    if (!hike.dimmed && !profileShowsWalk()) chart.setPosition(started ? along : null);
}

// ---------- Elevation profile: the track's, or the walk's own ----------

// With no track it is always the walk's; with one, Go › Track / My walk chooses.
function profileShowsWalk() {
    return !track || (currentTab === 'go' && settings.profileShows === 'walk');
}

function showProfile() {
    if (planner.active) return; // the planner draws its own
    const walk = profileShowsWalk();
    for (const b of $('profile-switch').querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b.dataset.show === (walk ? 'walk' : 'track')));
    }
    if (walk) renderWalkProfile();
    else chart.setData(track, track.profile);
    renderTrip();
}

// The walk so far: elevation (DEM) against distance along the recorded path, with
// a dot where you are. Rebuilt with the walked line (at most every 5 s, not while dimmed).
function renderWalkProfile() {
    const points = walkedPoints();
    if (points.length < 2) {
        chart.setData(null, null, { empty: 'Your walk’s elevation profile appears here after Start.' });
        return;
    }
    const walkTrack = buildTrack(points);
    chart.setData(walkTrack, buildProfile(walkTrack, settings.eleThresholdM),
        { empty: 'Elevation unavailable (no signal): it fills in once the DEM can be reached.' });
    chart.setPosition(hike.running ? walkTrack.total : null);
}

for (const b of $('profile-switch').querySelectorAll('button')) {
    b.addEventListener('click', () => {
        settings.profileShows = b.dataset.show;
        saveSettings();
        showProfile();
    });
}

// eleInfo: { own (from the file), dem (from the DEM), missing, status:
// 'ok' | 'loading' | 'failed' | 'tooLarge' }.
function elevationText({ points, eleInfo: e }) {
    const n = points.length;
    if (e.status === 'loading') return `Elevation: getting ${e.missing} of ${n} points from the DEM (${DEM_NAME})…`;
    if (!e.dem && !e.missing) return `Elevation: all ${n} points from the file`;
    const parts = [];
    if (e.own) parts.push(`${e.own} from the file`);
    if (e.dem) parts.push(`${e.dem} from the DEM (${DEM_NAME})`);
    if (e.missing && e.status === 'tooLarge') parts.push('track too spread out to fetch the DEM');
    else if (e.missing) parts.push('DEM not reachable (offline?): Fill elevations retries');
    return `Elevation: ${n - e.missing} of ${n} points · ${parts.join(' · ')}`;
}

// The path actually walked, on the map. Redrawn at most every few seconds
// (and never while dimmed) to save battery; force after a big change.
let walkedDrawnAt = 0;
function renderWalkedPath(force = false) {
    if (hike.dimmed) return;
    const now = Date.now();
    if (!force && now - walkedDrawnAt < WALKED_REDRAW_MS) return;
    walkedDrawnAt = now;
    view.setWalked(splitGaps(path.snapshot()));
    if (profileShowsWalk() && !planner.active && settings.panelOpen) renderWalkProfile();
}

// Distance actually walked and moving/stopped time (from the motion tracker).
function renderWalk(now = Date.now()) {
    motion.tick(now);
    const totals = walkTotals(now);
    const recorded = totals.movingMs + totals.stoppedMs + totals.pausedMs > 0;
    const walked = recorded ? formatDistance(totals.walked) : '–';
    const moving = recorded ? formatDuration(totals.movingMs) : '–';
    // Average speed over moving time only; meaningless in the first minute.
    const speed = totals.movingMs >= 60_000 ? units.speed(totals.walked / (totals.movingMs / 1000)) : '–';
    const stopped = motion.state === 'STOPPED';
    // Current speed over the last 15 s; nothing once the fixes stop coming.
    const fresh = hike.running && hike.lastFixAt && now - hike.lastFixAt < SPEED_WINDOW_MS;
    const speedNow = !fresh ? '–' : stopped ? units.speed(0) : units.speed(rates.speed(now));
    // DEM elevation here (never GPS altitude).
    const e = hike.ele;
    const eleText = !hike.running ? '–' : Number.isFinite(e.ele) ? formatMetres(e.ele)
        : e.status === 'unavailable' ? 'unavailable' : e.status === 'loading' ? '…' : '–';
    const ascent = recorded ? formatMetres(totals.ascent) : '–';
    const per = settings.vSpeedPer;
    const v = fresh && !stopped ? rates.vertical(now) : null;
    let vertical = '–';
    if (fresh && stopped) vertical = 'level';
    else if (v != null) vertical = Math.abs(v) <= LEVEL_MPS ? 'level' : `${v > 0 ? '↑' : '↓'} ${units.verticalSpeed(v, per)}`;
    const avg = averageRates(climb, rates);

    setText($('w-walked'), walked);
    setText($('w-moving'), moving);
    setText($('w-stopped'), recorded ? formatDuration(totals.stoppedMs) : '–');
    setText($('w-paused'), totals.pausedMs > 0 ? formatDuration(totals.pausedMs) : '–');
    setText($('w-speed'), speed);
    setText($('w-speed-now'), speedNow);
    setText($('w-ele'), eleText);
    setText($('w-ascent'), ascent);
    setText($('w-descent'), recorded ? formatMetres(totals.descent) : '–');
    setText($('w-vert'), vertical);
    setText($('w-vert-up'), avg.up == null ? '–' : `↑ ${units.verticalSpeed(avg.up, per)}`);
    setText($('w-vert-down'), avg.down == null ? '–' : `↓ ${units.verticalSpeed(avg.down, per)}`);
    const note = $('walk-note');
    note.hidden = !(hike.running && e.status === 'unavailable');
    if (!note.hidden) setText(note, 'Elevation unavailable: no signal, and this area’s elevation tile isn’t stored on the device yet. Ascent and descent carry on once it can be reached.');
    // Free recording (no track): these replace Done/Remaining/From track.
    if (!track) {
        setText($('stat-walked'), walked);
        setText($('stat-moving'), moving);
        setText($('stat-speed'), speedNow);
        setText($('dim-walked'), walked);
        setText($('dim-moving'), moving);
        setText($('dim-speed'), speedNow);
        setText($('dim-ascent'), ascent);
    }

    $('save-walk-btn').hidden = hike.running || !walkUnsaved();

    const status = $('motion-status');
    status.hidden = !hike.running;
    let text = stopped ? `Stopped ${formatDuration(now - motion.stoppedSince)}` : 'Moving';
    if (pauseWatch) text = `Paused ${formatDuration(now - pauseWatch.since)}`;
    setStatus(status, text, stopped || pauseWatch ? 'warn' : '');
    setText($('dim-motion'), hike.running ? text : '');
    $('pause-btn').hidden = !hike.running;
    setText($('pause-btn'), pauseWatch ? 'Resume' : 'Pause');
    $('pause-btn').classList.toggle('paused', Boolean(pauseWatch));
}

// No track loaded = free recording: Start still records the walk, and the
// parts that compare against a track are hidden.
function renderTrackStatus() {
    document.body.classList.toggle('free-mode', !track);
    $('go-dot').hidden = !hike.running; // the hike goes on while other tabs are shown
    $('edit-loaded-btn').disabled = !track;
    let text = hike.running ? 'Free recording (no track)' : 'No track · Start records a free walk';
    if (track) text = `${track.name || 'Track'} · ${formatDistance(track.total)}`;
    setText($('track-status'), text);
    renderWalk();
}

function pushLimited(list, item) {
    list.push(item);
    if (list.length > DEBUG_HISTORY) list.shift();
}

// Track-elevation change over the stop-time window, shown moving or stopped, so
// a slow climb can be compared with standing still on a slope to pick the
// "...unless the track climbed more than" setting (a stop needs the change at or below it).
function climbLine(now) {
    const source = track?.profile ? 'track' : 'DEM';
    const w = trimToWindow(debug.eles, now, settings.stopTimeS * 1000);
    if (w.length < 2) return `Climb    – (waiting for fixes)`;
    const range = elevationRange(w);
    const spanS = (w[w.length - 1].time - w[0].time) / 1000;
    const net = w[w.length - 1].ele - w[0].ele;
    const rate = spanS > 0 ? Math.round(Math.abs(net) / spanS * 3600) : 0;
    return `Climb (${source}) ${formatMetres(range, 1)} in ${Math.round(spanS)} s (net ${net >= 0 ? '+' : '−'}${formatMetres(Math.abs(net), 1)}, ` +
        `${formatMetres(rate)}/h); limit ${formatMetres(settings.stopClimbM, 1)}` +
        (range > settings.stopClimbM ? ' → not a stop' : '');
}

function renderDebug() {
    const box = $('debug-box');
    box.hidden = !settings.debug;
    if (!settings.debug) return;

    const raw = debug.raw[debug.raw.length - 1];
    const sm = debug.smooth[debug.smooth.length - 1];
    const now = Date.now();
    const stopped = motion.state === 'STOPPED';
    const lines = [
        `State    ${hike.running ? motion.state : 'not recording'}` +
            (stopped ? ` ${formatDuration(now - motion.stoppedSince)}` : ''),
        raw ? `Raw      ±${formatMetres(raw.acc)} ${raw.accepted ? 'used' : 'DISCARDED'}` +
            (debug.lastInterval ? `, every ${(debug.lastInterval / 1000).toFixed(1)} s` : '') : 'Raw      –',
        `Discard  ${debug.discarded} fixes worse than ${formatMetres(settings.maxAccuracyM)}`,
        sm ? `Smooth   ${sm.count}/${settings.smoothWindow} fixes, ±${formatMetres(sm.acc, 1)}` : 'Smooth   –',
        raw && sm ? `Raw→smooth ${formatMetres(haversine(raw, sm), 1)}` : 'Raw→smooth –',
        stopped
            ? `Stop     inside ${formatMetres(motion.radius)} of stop centre`
            : `Stop chk spread ${formatMetres(motion.history.length > 1 ? motion.spread() : 0)} of ${formatMetres(motion.radius)}, ` +
              `need ${settings.stopTimeS} s`,
        climbLine(now),
        hike.progress ? `Snapped  ${formatDistance(hike.progress.along)}, ${formatMetres(hike.progress.offset)} off` : 'Snapped  –',
        `Walked   ${formatDistance(motion.walked)} + ${gaps.length} gaps ${formatDistance(walkTotals().walked - motion.walked)}, ↑ ${formatMetres(climb.ascent)} ↓ ${formatMetres(climb.descent)}`,
        `DEM here ${Number.isFinite(hike.ele.ele) ? formatMetres(hike.ele.ele, 1) : hike.ele.status || '–'}`,
    ];
    setText(box, lines.join('\n'));

    if (!hike.dimmed) {
        view.setDebug({
            raw: debug.raw,
            smooth: debug.smooth,
            stop: stopped ? { centre: motion.anchor, radius: motion.radius } : null,
        });
    }
}

// ---------- Track loading ----------

// Walked distance and moving/stopped time start again from zero.
function resetTrip() {
    const wasRecording = motion.lastTick != null;
    motion.reset();
    smoother.reset();
    path.reset();
    if (wasRecording) {
        motion.start(Date.now());
        path.startSegment();
    }
    debug.eles = [];
    debug.raw = [];
    debug.smooth = [];
    debug.discarded = 0;
    hike.savedPoints = 0;
    hike.walkId = null;
    climb.reset();
    rates.reset();
    gaps = [];
    hike.lastGood = null;
    hike.gapMark = null;
    endPause({ discard: true });
    hike.pausedMs = 0;
    hike.alertOverride = null; // the Go › Alerts choice lasts one hike
    renderAlertToggle();
    renderWalk();
    renderDebug();
    renderWalkedPath(true);
    saveRecording();
}

// ---------- Recording persistence (survives iOS closing the app) ----------

const RECORDING_SAVE_EVERY_S = 10;

// Identifies the loaded track, so progress is only restored onto the same one.
function trackKeyOf(t) {
    return `${t.name}|${t.points.length}|${Math.round(t.total)}`;
}

function trackKey() {
    return track ? trackKeyOf(track) : null;
}

// Saved every 10 s while hiking, on every moving/stopped change, on Start/Stop,
// and when the app goes to the background (the last chance before a force-close).
function saveRecording() {
    motion.tick(Date.now());
    const record = {
        trackKey: trackKey(),
        running: hike.running,
        motion: motion.snapshot(),
        path: path.snapshot(),
        prevAlong: hike.prevAlong,
        progress: hike.progress,
        savedPoints: hike.savedPoints,
        walkId: hike.walkId,
        walk: walkSnapshot(climb, rates),
        gaps,
        pausedMs: hike.pausedMs,
        pause: pauseWatch?.snapshot() ?? null,
        alertOverride: hike.alertOverride,
        savedAt: Date.now(),
    };
    kvSet('recording', record).catch((err) => console.error('Saving recording failed:', err));
}

// Time was recorded: without any, restoreRecording has nothing to bring back.
const recordingHasTime = (saved) => saved.motion.movingMs + saved.motion.stoppedMs > 0;

// A hike on this track that was running when the app closed, so the Resume prompt
// will show. Only this brings the test loop back.
function hasHikeToResume(saved, key) {
    return Boolean(saved?.running) && saved.trackKey === key && recordingHasTime(saved);
}

// Stops any hike and clears the recording, here and on the device.
function discardRecording() {
    if (hike.running) stopHike();
    resetTrip();
    kvDelete('recording').catch(() => {});
}

function restoreRecording(saved) {
    if (!saved || !recordingHasTime(saved)) return;

    const apply = () => {
        motion.restore(saved.motion);
        path.restore(saved.path);
        restoreWalk(climb, rates, saved.walk);
        gaps = Array.isArray(saved.gaps) ? saved.gaps : [];
        hike.pausedMs = saved.pausedMs ?? 0;
        hike.savedPoints = saved.savedPoints ?? 0;
        hike.walkId = saved.walkId ?? null;
        hike.alertOverride = saved.alertOverride ?? null;
        renderAlertToggle();
        if (saved.trackKey && saved.trackKey === trackKey() && saved.progress) {
            hike.prevAlong = saved.prevAlong;
            hike.progress = saved.progress;
        }
        renderStats();
        renderWalk();
        renderDebug();
        renderWalkedPath(true);
        showProfile();
        retryGaps(); // gaps left "to be filled" when the app closed
    };
    // Stopped on purpose last time: just bring the numbers back.
    if (!saved.running) {
        apply();
        return;
    }

    const ago = Math.max(0, Date.now() - saved.savedAt);
    const sameTrack = saved.trackKey === trackKey();
    setText($('resume-details'),
        `Walked ${formatDistance(saved.motion.walked)} · moving ${formatDuration(saved.motion.movingMs)} · ` +
        `stopped ${formatDuration(saved.motion.stoppedMs)}` + (saved.gaps?.length ? ' (plus filled gaps)' : '') +
        (sameTrack && saved.progress ? ` · ${formatDistance(saved.progress.along)} along ${track.name || 'the track'}` : '') +
        `. Saved ${ago < 60_000 ? 'less than a minute' : `${Math.round(ago / 60_000)} min`} ago. ` +
        'Resume fills the time the app was closed by guessing the way you walked.');
    $('resume-dialog').showModal();
    // Handled on the tap itself, so Start may use Wake Lock and sound.
    $('resume-yes').onclick = () => {
        $('resume-dialog').close();
        showTab('go');
        apply();
        // The time the app was closed becomes a gap from the last recorded point to
        // the first fix, filled like any other (not a new segment, not lost).
        const last = path.segments.flat().at(-1);
        if (saved.pause) {
            // Still paused: the closed time is pause time (no gap); positions are watched again.
            startHike();
            enterPause(PauseWatcher.restore(saved.pause));
            return;
        }
        if (last) {
            hike.lastGood = {
                lat: last.lat, lon: last.lon, time: last.time, ele: last.ele,
                along: sameTrack ? saved.progress?.along ?? null : null,
                onTrack: Boolean(sameTrack && saved.progress && saved.progress.offset <= settings.offTrackM),
            };
            motion.atFix = { time: saved.savedAt, movingMs: saved.motion.movingMs, stoppedMs: saved.motion.stoppedMs };
            hike.continueSegment = true;
        }
        startHike();
    };
    // Start fresh discards the recording; a free one that was never exported
    // or saved gets the same "keep it?" question as loading a track.
    $('resume-no').onclick = async () => {
        $('resume-dialog').close();
        apply();
        if (await keepRecording('Starting fresh')) {
            discardRecording();
            if (track?.temporary) await clearTrack();
        }
    };
}

// eleInfo: pass the saved one when restoring; otherwise elevations in the file
// count as "own" and missing ones are fetched from the DEM.
async function setTrack(name, points, { save = true, eleInfo = null, temporary = false, waypoints = [] } = {}) {
    const own = points.filter((p) => Number.isFinite(p.ele)).length;
    track = { name, ...buildTrack(points), temporary };
    track.waypoints = locateWaypoints(track, waypoints);
    renderWaypoints();
    track.eleInfo = eleInfo ? { ...eleInfo } : { own, dem: 0, missing: points.length - own, status: 'ok' };
    track.profile = buildProfile(track, settings.eleThresholdM);
    hike.prevAlong = 0;
    hike.progress = null;
    resetOffTrack();
    view.setTrack(points);
    view.fitTrack(points);
    renderTrackStatus();
    showProfile();
    renderStats();
    if (save) await saveTrack();
    if (track.eleInfo.missing) fillTrackElevations();
}

async function saveTrack() {
    const { name, points, eleInfo, temporary, waypoints } = track;
    try {
        await kvSet('track', { name, points, eleInfo: { ...eleInfo, status: eleInfo.status === 'loading' ? 'failed' : eleInfo.status }, temporary, waypoints });
        requestPersistence();
    } catch (err) {
        console.error('Saving track failed:', err);
        toast('Track shown, but it could not be saved on this device.');
    }
}

// Missing elevations from the DEM (needs the network). The track keeps them,
// so this happens once per track; Go › Fill elevations retries.
async function fillTrackElevations() {
    const t = track;
    if (!t?.eleInfo.missing || t.eleInfo.status === 'loading') return;
    t.eleInfo.status = 'loading';
    renderTrip();
    let result = null;
    try {
        result = await fillElevationsFromDem(t.points);
    } catch (err) {
        console.error('DEM elevations failed:', err);
    }
    if (track !== t) return; // another track was loaded meanwhile
    if (result?.filled) {
        t.points = result.points;
        t.eleInfo.dem += result.filled;
        t.eleInfo.missing = result.missing;
        t.profile = buildProfile(t, settings.eleThresholdM);
        showProfile();
    }
    t.eleInfo.status = !t.eleInfo.missing ? 'ok' : result?.tooLarge ? 'tooLarge' : 'failed';
    renderTrip();
    if (result?.filled) await saveTrack();
}

window.addEventListener('online', () => {
    if (track?.eleInfo.status === 'failed') fillTrackElevations();
});

async function clearTrack() {
    track = null;
    hike.progress = null;
    resetOffTrack();
    view.clearTrack();
    renderWaypoints();
    renderTrackStatus();
    showProfile();
    renderStats();
    try {
        await kvDelete('track');
    } catch (err) {
        console.error('Removing track failed:', err);
    }
}

// Unload track, or Remove test loop. Library copies are kept. An ordinary track
// leaves the recording alone; the test loop takes its test hike with it, so the
// app opens clean afterwards. Resolves true if the track was removed.
async function removeLoadedTrack({ confirmed = false } = {}) {
    if (!track) {
        toast('No track loaded.');
        return false;
    }
    if (track.temporary) {
        if (walkUnsaved()) {
            if (!await keepRecording('Removing the test loop')) return false;
        } else if (!confirmed && !confirm(hike.running || path.pointCount
            ? 'Remove the test loop? Its test hike is stopped and cleared.'
            : 'Remove the test loop?')) {
            return false;
        }
        discardRecording();
    } else if (!confirmed && !confirm(`Unload “${track.name || 'the track'}”? Copies in the Track Library are kept.`)) {
        return false;
    }
    await clearTrack();
    renderLibrary();
    return true;
}

// On opening: the saved track (the test loop only while a hike with it was in
// progress), then the recording. With no track, the map opens where you are.
async function restoreAll() {
    let savedTrack = null, savedRecording = null;
    try {
        [savedTrack, savedRecording] = await Promise.all([kvGet('track'), kvGet('recording')]);
    } catch (err) {
        console.error('Loading saved data failed:', err);
    }
    if (savedTrack?.points?.length >= 2) {
        const key = trackKeyOf({ name: savedTrack.name, ...buildTrack(savedTrack.points) });
        // A test loop saved before v0.6.0 has no flag: its name is all there is to go on.
        const temporary = savedTrack.temporary ?? savedTrack.name === 'Test loop';
        if (!temporary || hasHikeToResume(savedRecording, key)) {
            await setTrack(savedTrack.name, savedTrack.points,
                { save: false, eleInfo: savedTrack.eleInfo, temporary, waypoints: savedTrack.waypoints });
        } else {
            kvDelete('track').catch(() => {});
        }
    }
    restoreRecording(savedRecording);
    if (!track) {
        openOnMyPosition();
        toast('Search a place, load a track from the Track Library, or Go › Start to record a walk.', 5000);
    }
}

// Where the last recording ended, else the current position (if location is allowed).
function openOnMyPosition() {
    const last = path.segments.flat().at(-1);
    if (last) return view.jumpTo(last);
    if (!('geolocation' in navigator)) return;
    navigator.geolocation.getCurrentPosition((pos) => {
        if (!track && !hike.lastFix) view.jumpTo({ lat: pos.coords.latitude, lon: pos.coords.longitude });
    }, () => {}, { maximumAge: 300_000, timeout: 15_000 });
}

$('gpx-input').addEventListener('change', async (event) => {
    const files = Array.from(event.target.files);
    event.target.value = ''; // allow choosing the same file again
    if (files.length > 1) return importGpxFiles(files);
    const file = files[0];
    if (!file) return;
    try {
        const { name, points, waypoints, type } = parseGpx(await file.text());
        const trackName = name || file.name.replace(/\.gpx$/i, '');
        if (!await keepRecording(`Opening “${trackName}”`)) return;
        await setTrack(trackName, points, { waypoints });
        resetTrip();
        // Imported tracks go into the Track Library too (with DEM elevations once fetched).
        await saveLibraryEntry(importedEntry(trackName, track.points, track.eleInfo, waypoints, type));
        renderLibrary();
        showTab('go');
        toast(`Imported ${formatDistance(track.total)} ${type === 'walk' ? 'walk' : 'track'} into the Track Library: Start to follow it.`);
    } catch (err) {
        console.error('GPX import failed:', err);
        toast(err.message || 'Could not read this file.', 5000);
    }
});

// A Track Library entry for an imported file. A walk exported by Trails (<type>walk</type>)
// goes back under Walks.
let importCount = 0;
function importedEntry(name, points, eleInfo, waypoints, type) {
    const walk = type === 'walk';
    const id = `${walk ? 'walk-gpx' : 'gpx'}-${Date.now()}-${importCount++}`;
    return { id, kind: walk ? 'walk' : 'track', name, points, eleInfo, waypoints, savedAt: Date.now() };
}

// Several files at once (moving to a new address): all go into the Track Library,
// nothing is loaded, so the recording and the loaded track are left alone.
async function importGpxFiles(files) {
    let tracks = 0, walks = 0;
    const failed = [];
    for (const file of files) {
        try {
            const { name, points, waypoints, type } = parseGpx(await file.text());
            const own = points.filter((p) => Number.isFinite(p.ele)).length;
            const eleInfo = { own, dem: 0, missing: points.length - own, status: 'ok' };
            await saveLibraryEntry(importedEntry(name || file.name.replace(/\.gpx$/i, ''), points, eleInfo, waypoints, type));
            if (type === 'walk') walks++; else tracks++;
        } catch (err) {
            console.error('GPX import failed:', file.name, err);
            failed.push(file.name);
        }
    }
    renderLibrary();
    showTab('library');
    const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
    toast(`Imported ${plural(tracks, 'track')} and ${plural(walks, 'walk')} into the Track Library.` +
        (failed.length ? ` Could not read: ${failed.join(', ')}.` : ''), failed.length ? 8000 : 4000);
}

// ---------- Off-track detection and alerts ----------

function resetOffTrack() {
    offTrack.reset();
    hike.offTrack = false;
}

// This hike's alert mode: Go › Alerts if changed there, else Settings › Alerts.
function alertMode() {
    return hike.alertOverride ?? settings.alertMode;
}

const ALERT_LABELS = { off: 'off', banner: 'banner only', sound: 'banner + sound' };

function renderAlertToggle() {
    const mode = alertMode();
    setText($('alert-toggle'), `Alerts: ${ALERT_LABELS[mode]}`);
    $('alert-toggle').classList.toggle('warn', mode === 'off');
}

// Off/on track is always worked out (it drives the "Off track" numbers); the
// alert setting only decides whether a banner shows and a sound plays.
function updateOffTrack(offset, limit) {
    const change = offTrack.update(offset, limit);
    hike.offTrack = offTrack.offTrack;
    if (change === 'back' && alertMode() !== 'off') toast('Back on track.');
    if (change === 'off' || (hike.offTrack && Date.now() - hike.lastAlertAt > ALERT_REPEAT_MS)) alertUser();
}

// The banner shows from renderStats; Banner + sound also beeps (and vibrates on
// Android: iPhone Safari has no web vibration), again every minute while off track.
function alertUser() {
    hike.lastAlertAt = Date.now();
    if (alertMode() !== 'sound') return;
    navigator.vibrate?.([400, 200, 400]);
    beep();
}

// Go › Alerts: Off → Banner only → Banner + sound, for this hike only.
$('alert-toggle').addEventListener('click', () => {
    const mode = nextAlertMode(alertMode());
    hike.alertOverride = mode === settings.alertMode ? null : mode;
    if (mode === 'sound') {
        unlockAudio();
        beep(); // you hear what the alert sounds like, and how loud
    }
    renderAlertToggle();
    renderStats();
    saveRecording();
    toast(`Off-track alerts for this hike: ${ALERT_LABELS[mode]}` +
        (hike.alertOverride ? ` (Settings › Alerts stays ${ALERT_LABELS[settings.alertMode]}).` : ', as in Settings.'));
});

let audioCtx = null;

// Must run inside a tap: iOS only allows sound from an audio context
// that was started by the user.
function unlockAudio() {
    if (audioCtx) {
        audioCtx.resume().catch(() => {});
        return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    try {
        // Short alert sounds that duck (rather than stop) music, where supported.
        if (navigator.audioSession) navigator.audioSession.type = 'transient';
    } catch {
        // Not supported: fall back to the default audio behaviour.
    }
    audioCtx = new Ctx();
    const silent = audioCtx.createBufferSource();
    silent.buffer = audioCtx.createBuffer(1, 1, 22050);
    silent.connect(audioCtx.destination);
    silent.start();
}

function beep() {
    if (!audioCtx) return;
    if (audioCtx.state !== 'running') audioCtx.resume().catch(() => {});
    const now = audioCtx.currentTime;
    [[880, 0], [660, 0.25], [880, 0.5]].forEach(([freq, offset]) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.5, now + offset + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.2);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.22);
    });
}

// ---------- Screen wake lock ----------

let wakeLock = null;

async function requestWakeLock() {
    const status = $('wake-status');
    status.hidden = false;
    if (!('wakeLock' in navigator)) {
        setStatus(status, 'Screen may lock (no Wake Lock)', 'warn');
        return;
    }
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        setStatus(status, 'Screen awake', 'ok');
        wakeLock.addEventListener('release', () => {
            wakeLock = null;
            if (hike.running) setStatus(status, 'Screen may lock — tap to retry', 'warn');
        });
    } catch (err) {
        console.warn('Wake Lock failed:', err);
        setStatus(status, 'Screen may lock — tap to retry', 'warn');
    }
}

function releaseWakeLock() {
    wakeLock?.release().catch(() => {});
    wakeLock = null;
    $('wake-status').hidden = true;
}

$('wake-status').addEventListener('click', () => {
    if (hike.running && !wakeLock) requestWakeLock();
});

// ---------- Dim mode (black screen) and auto-dim ----------

let idleTimer = null;

function enterDim() {
    hike.dimmed = true;
    $('dim-overlay').hidden = false;
}

function exitDim() {
    if (!hike.dimmed) return;
    hike.dimmed = false;
    $('dim-overlay').hidden = true;
    // The map and profile marker are not updated while dimmed; catch up now.
    if (hike.lastFix) view.showPosition(hike.lastFix, { offTrack: hike.offTrack });
    renderWalkedPath(true);
    renderTrip();
    renderDebug();
}

function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!hike.running || hike.dimmed || settings.autoDimS <= 0) return;
    idleTimer = setTimeout(() => {
        if (currentTab !== 'settings') enterDim();
    }, settings.autoDimS * 1000);
}

document.addEventListener('pointerdown', resetIdleTimer, { capture: true });

$('dim-overlay').addEventListener('click', () => {
    exitDim();
    resetIdleTimer();
});

$('dim-btn').addEventListener('click', () => {
    if (!hike.running) toast('Dim keeps showing your progress while hiking.');
    enterDim();
});

// ---------- GPS ----------

// Each GPS fix: discard if inaccurate -> smooth -> moving/stopped -> snap to track.
function onFix(position) {
    const now = Date.now();
    const raw = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        acc: position.coords.accuracy,
        time: now,
    };
    debug.lastInterval = hike.lastFixAt ? now - hike.lastFixAt : null;
    hike.lastFixAt = now;

    // No usable fix for 20 s or more (background, screen locked, closed and resumed,
    // no GPS): a gap. Old fixes must not be averaged with the new position.
    const gapFrom = hike.lastGood && now - hike.lastGood.time >= GAP_MIN_MS ? hike.lastGood : null;
    if (gapFrom) smoother.reset();
    const smoothed = smoother.add(raw);
    pushLimited(debug.raw, { ...raw, accepted: Boolean(smoothed) });
    if (!smoothed) {
        debug.discarded++;
        setStatus($('gps-status'), `GPS weak ±${formatMetres(raw.acc)} (ignored)`, 'warn');
        renderDebug();
        return;
    }
    pushLimited(debug.smooth, smoothed);
    setStatus($('gps-status'), `GPS ±${formatMetres(raw.acc)}`, 'ok');
    // Paused: positions are watched, nothing counts (unless this one resumes the hike).
    if (pauseWatch && !pausedFix(smoothed, raw.acc, now)) return;
    const gapStart = gapFrom ?? (hike.lastGood && now - hike.lastGood.time >= GAP_MIN_MS ? hike.lastGood : null);
    if (gapStart) startGap(gapStart, smoothed, now);

    // Snap first (while moving): stop detection uses the track elevation here
    // to tell a slow steep climb from a stop.
    const loc = track && motion.state !== 'STOPPED' ? locateOnTrack(track, smoothed, hike.prevAlong) : null;
    const trackEle = loc && track.profile ? profileAt(track, track.profile, loc.along).ele : null;
    // DEM elevation at the smoothed position: the walk's own elevation, ascent and descent.
    const dem = elevationAt(smoothed.lat, smoothed.lon);
    const demEle = Number.isFinite(dem.ele) ? dem.ele : null;
    const anchor = motion.anchor; // update() clears it when walking resumes
    // Slow-climb check: the track's elevation when there is one, else the DEM's.
    const change = motion.update(smoothed, raw.acc, now, track?.profile ? trackEle : demEle);
    const stopped = motion.state === 'STOPPED';
    if (change) rates.clear(); // the walked distance jumps at a stop: speeds start again

    // While stopped nothing is added: position jitter is no climb.
    if (!stopped) {
        climb.add(demEle);
        rates.add({ time: now, walked: motion.walked, ele: demEle });
    }

    // Recorded path: the DEM elevation only (mixing in the track's would put steps in
    // the walk's profile); none while the DEM can't be reached (Save as track fills them).
    if (change === 'stopped') path.stop(motion.anchor, motion.stoppedSince);
    if (change === 'resumed') path.resume(anchor, now);
    if (!stopped) {
        path.add({ ...smoothed, ele: demEle, time: now, gapBefore: hike.gapMark }, { force: hike.gapMark != null });
        hike.gapMark = null;
    }
    if (change) saveRecording();

    if (settings.debug) {
        // The elevation the stop check uses. While stopped the track isn't snapped
        // for progress; snap here for the debug figure only.
        let e = demEle;
        if (track?.profile) e = loc ? trackEle : profileAt(track, track.profile, locateOnTrack(track, smoothed, hike.prevAlong).along).ele;
        if (Number.isFinite(e)) debug.eles.push({ time: now, ele: e });
        debug.eles = trimToWindow(debug.eles, now, settings.stopTimeS * 1000);
    }

    // While stopped, progress and position stay frozen at the stop's centre,
    // so jitter can neither move the numbers nor raise an off-track alarm.
    if (loc && !stopped) {
        hike.prevAlong = loc.along;
        hike.progress = { along: loc.along, offset: loc.offset };
        // Straight (cross-country) segments of a planned track allow more room.
        const straight = track.points[loc.index]?.straight;
        updateOffTrack(loc.offset, straight ? settings.offTrackStraightM : settings.offTrackM);
    }
    const shown = stopped ? motion.anchor : smoothed;
    hike.lastFix = { lat: shown.lat, lon: shown.lon, acc: raw.acc };
    hike.ele = stopped ? elevationAt(shown.lat, shown.lon) : dem;
    hike.lastGood = {
        lat: shown.lat, lon: shown.lon, time: now,
        ele: Number.isFinite(hike.ele.ele) ? hike.ele.ele : null,
        along: track && hike.progress ? hike.progress.along : null,
        onTrack: Boolean(track && hike.progress && !hike.offTrack),
    };
    if (hike.gapToFill) {
        fillGapNow(hike.gapToFill, true);
        hike.gapToFill = null;
    }
    renderWalkedPath(Boolean(change));

    // While dimmed the map is hidden: skip redrawing it to save battery.
    if (!hike.dimmed) view.showPosition(hike.lastFix, { offTrack: hike.offTrack });
    renderStats();
    renderWalk(now);
    renderDebug();
}

// ---------- Recording gaps ----------

// Routes implying a faster walk than this are not believed (Settings › Recording gaps).
// Simulated GPS walks SIM_SPEEDUP× faster, so its limit is raised to match.
const gapMaxSpeed = () => settings.gapMaxSpeedMps * (SIMULATE ? SIM_SPEEDUP : 1);

// A gap ended at pos: work out how to fill it, record it, and fill it in the
// background (never asks during the hike).
function startGap(last, pos, now) {
    const gapMs = Math.max(0, now - (motion.atFix?.time ?? last.time));
    const wasStopped = motion.state === 'STOPPED';
    const still = wasStopped && haversine(motion.anchor, pos) <= motion.radius;
    // Stopped before the gap and gone now: you stood there at least until the gap began.
    if (wasStopped && !still) path.add({ ...motion.anchor, ele: last.ele, time: last.time }, { force: true });
    motion.gap(now, pos, { still });
    climb.pause();
    rates.clear();
    if (still) {
        gapNotice({ gapMs, status: 'still' });
        return;
    }
    const demTo = elevationAt(pos.lat, pos.lon);
    const from = { lat: last.lat, lon: last.lon, time: last.time, ele: last.ele };
    const to = { lat: pos.lat, lon: pos.lon, time: now, ele: Number.isFinite(demTo.ele) ? demTo.ele : null };
    const durationMs = now - last.time;
    const maxSpeedMps = gapMaxSpeed();
    // On the loaded track before and after (same limits as the off-track check)?
    let alongAfter = null;
    if (track && last.onTrack && last.along != null) {
        const loc = locateOnTrack(track, pos, last.along);
        const limit = track.points[loc.index]?.straight ? settings.offTrackStraightM : settings.offTrackM;
        if (loc.offset <= limit) alongAfter = loc.along;
    }
    const plan = gapPlan({ from, to, durationMs, maxSpeedMps, track, alongBefore: alongAfter != null ? last.along : null, alongAfter });
    const straight = straightOption(from, to, durationMs);
    const gap = {
        id: `gap-${now}`, from, to, gapMs, durationMs, maxSpeedMps,
        paceMps: paceBefore(walkTotals(), maxSpeedMps), chosen: 0, options: [straight],
    };
    if (plan.kind === 'short') Object.assign(gap, { status: 'filled', source: 'short' });
    else if (plan.kind === 'track') Object.assign(gap, { status: 'filled', source: 'track', options: [plan.option, straight] });
    else if (plan.kind === 'far') Object.assign(gap, { status: 'guess', source: 'straight', note: 'too far for the trail router' });
    else Object.assign(gap, { status: 'pending', source: 'straight', note: 'finding the trail…' });
    gaps.push(gap);
    hike.gapMark = gap.id;    // the next recorded point closes the gap
    hike.gapToFill = gap;     // filled once that point is recorded (end of onFix)
}

// Draws the gap's chosen option into the recorded path and updates the totals.
function applyGap(gap) {
    replaceGapPoints(path.segments, gap.id, gapPathPoints(gap));
    renderWalk();
    renderWalkedPath(true);
    renderGapList();
    saveRecording();
}

async function fillGapNow(gap, announce = false) {
    applyGap(gap);
    const changed = await fillGap(gap);
    if (!gaps.includes(gap)) return; // the recording was reset meanwhile
    if (changed) applyGap(gap);
    if (announce || (changed && gap.status !== 'pending')) gapNotice(gap);
}

// Gaps still "to be filled" (no signal, limit) or missing elevations: on the way
// back online, when the app comes back, every minute while hiking, and on reopening.
let retrying = false;
async function retryGaps() {
    if (retrying || !navigator.onLine) return;
    retrying = true;
    try {
        for (const gap of gaps.filter(needsWork)) await fillGapNow(gap);
    } finally {
        retrying = false;
    }
}
window.addEventListener('online', retryGaps);

// "8 min", "45 s", "1 h 20 min".
function formatGapDuration(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} s`;
    const min = Math.round(s / 60);
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

const GAP_SOURCES = { route: 'along trails', track: 'along the track', short: 'straight (short)', straight: 'straight' };

// A short notice, once the gap is filled (or can't be yet). Not for brief GPS holes.
function gapNotice(gap) {
    const paused = `Paused ${formatGapDuration(gap.gapMs)}`;
    if (gap.status === 'still') {
        if (gap.gapMs >= 60_000) toast(`${paused}: you hadn't moved.`, 5000);
        return;
    }
    const { distance } = gapNumbers(gap, settings.eleThresholdM);
    if (gap.gapMs < 60_000 && distance < 50) return;
    const d = formatDistance(distance);
    let text = `${paused}, filled straight (${d}).`;
    if (gap.status === 'pending') text = `${paused}: ${gap.note}; straight for now.`;
    else if (gap.status === 'guess') text = `${paused}: ${gap.note}, drawn straight (${d}, a guess).`;
    else if (gap.source === 'route') text = `${paused}, filled from trails (${d}).`;
    else if (gap.source === 'track') text = `${paused}, filled along the track (${d}).`;
    toast(text, 6000);
}

// ---------- Smart Pause ----------

function enterPause(watcher) {
    const now = Date.now();
    motion.pause(now);        // the clocks stop; walking about counts for nothing
    climb.pause();
    rates.clear();
    resetOffTrack();
    hike.lastGood = null;     // a pause is never a gap
    hike.gapMark = null;
    pauseWatch = watcher;
    view.setPauseZone(watcher.centre, watcher.radiusM);
    renderStats();
    renderWalk(now);
    saveRecording();
}

function pauseHike() {
    if (!hike.running || pauseWatch) return;
    const here = hike.lastFix ?? path.segments.flat().at(-1);
    if (!here) return toast('Waiting for GPS: Pause works once your position shows.');
    hideUndo();
    enterPause(new PauseWatcher({ centre: here, radiusM: settings.pauseRadiusM, since: Date.now(), maxSpeedMps: gapMaxSpeed() }));
    toast(`Paused. Nothing counts until you leave the ${formatMetres(settings.pauseRadiusM)} zone and walk on (or press Resume).`, 5000);
}

// Ends a pause: its time goes to Paused (discard: the recording is being reset).
function endPause({ discard = false, until = Date.now() } = {}) {
    if (!pauseWatch) return;
    if (!discard) hike.pausedMs += Math.max(0, until - pauseWatch.since);
    pauseWatch = null;
    view.setPauseZone(null);
    hidePauseBanner();
}

// A position while paused. Resolves true when it ended the pause and the fix
// should be handled as a normal one (after the phone was locked: a gap follows).
function pausedFix(p, acc, now) {
    const dem = elevationAt(p.lat, p.lon);
    let along = null, onTrack = false;
    if (track) {
        const loc = locateOnTrack(track, p, hike.prevAlong);
        const limit = track.points[loc.index]?.straight ? settings.offTrackStraightM : settings.offTrackM;
        along = loc.along;
        onTrack = loc.offset <= limit;
    }
    const point = { lat: p.lat, lon: p.lon, time: now, acc, ele: Number.isFinite(dem.ele) ? dem.ele : null, along, onTrack };
    const decision = pauseWatch.add(point);
    hike.lastFix = { lat: p.lat, lon: p.lon, acc };
    hike.ele = dem;
    if (decision.action === 'ask') showPauseBanner('ask');
    if (decision.action === 'none' && pauseWatch.inside(point)) hidePauseBanner('ask');
    if (decision.action === 'resume') {
        resumeFromPause({ auto: true });
        return false; // this position was counted in the replay
    }
    if (decision.action === 'jump') {
        resumeFromPause({ auto: true, jump: decision, to: point });
        return true;
    }
    if (!hike.dimmed) view.showPosition(hike.lastFix);
    renderWalk(now);
    return false;
}

// Counts one position as the live fixes do (used to replay the walk since leaving the zone).
function countPoint(p) {
    const anchor = motion.anchor;
    const change = motion.update(p, p.acc, p.time, p.ele);
    const stopped = motion.state === 'STOPPED';
    if (change) rates.clear();
    if (!stopped) {
        climb.add(p.ele);
        rates.add({ time: p.time, walked: motion.walked, ele: p.ele });
    }
    if (change === 'stopped') path.stop(motion.anchor, motion.stoppedSince);
    if (change === 'resumed') path.resume(anchor, p.time);
    if (!stopped) path.add({ lat: p.lat, lon: p.lon, ele: p.ele, time: p.time });
    if (p.onTrack && Number.isFinite(p.along)) hike.prevAlong = p.along;
}

// Resume: from where you left the zone if you are outside it now (the positions
// since then count), else from now (always from now after Undo). After the phone was locked and you are far
// away (jump): from the zone's edge, with the unseen walk filled as a gap.
function resumeFromPause({ auto = false, jump = null, to = null } = {}) {
    const w = pauseWatch;
    if (!w) return;
    const now = Date.now();
    hike.undo = auto ? undoSnapshot(w) : null;
    // After Undo (e.g. the walk back to the car), Resume counts from now.
    const outside = !w.autoOff && w.outside.length && !w.inside(w.outside.at(-1)) ? w.outside : [];
    let start = outside.length ? outside[0].time : now;
    let edge = null;
    if (jump && !outside.length) {
        // Nothing seen since the zone: you walked from its edge to here at your pace,
        // the rest of the time was still the pause.
        const pace = paceBefore(walkTotals(now), gapMaxSpeed());
        start = now - walkedUnseenMs(jump.exit, to, pace, now - jump.holeFrom);
        const e = elevationAt(jump.exit.lat, jump.exit.lon);
        edge = { lat: jump.exit.lat, lon: jump.exit.lon, time: start, ele: Number.isFinite(e.ele) ? e.ele : null };
    }
    endPause({ until: start });
    motion.start(start);
    path.startSegment(); // the pause is a break in the walked line (and its own GPX segment)
    climb.pause();
    rates.clear();
    smoother.reset();
    for (const p of outside) countPoint(p);
    const last = outside.at(-1) ?? edge;
    if (edge) {
        path.add(edge, { force: true });
        motion.atFix = { time: start, movingMs: motion.movingMs, stoppedMs: motion.stoppedMs };
    }
    hike.lastGood = last ? { lat: last.lat, lon: last.lon, time: last.time, ele: last.ele ?? null, along: last.along ?? null, onTrack: Boolean(last.onTrack) } : null;
    if (auto) showPauseBanner('resumed');
    else hidePauseBanner();
    renderStats();
    renderWalk(now);
    renderWalkedPath(true);
    saveRecording();
}

// What an automatic resume changes, to put back with Undo.
function undoSnapshot(w) {
    return structuredClone({
        motion: { ...motion },
        path: path.segments,
        climb: { ascent: climb.ascent, descent: climb.descent },
        rates: { upMs: rates.upMs, downMs: rates.downMs },
        gaps,
        pausedMs: hike.pausedMs,
        watcher: w.snapshot(),
        prevAlong: hike.prevAlong,
        progress: hike.progress,
    });
}

// Undo: back to paused as if the resume never happened (e.g. you walked back to
// the car). Only a manual Resume ends this pause now.
function undoResume() {
    const u = hike.undo;
    if (!u || !hike.running) return hideUndo();
    hike.undo = null;
    Object.assign(motion, u.motion);
    path.segments = u.path;
    Object.assign(climb, u.climb);
    climb.pause();
    Object.assign(rates, u.rates);
    rates.clear();
    gaps = u.gaps;
    hike.pausedMs = u.pausedMs;
    hike.prevAlong = u.prevAlong;
    hike.progress = u.progress;
    const watcher = PauseWatcher.restore(u.watcher);
    watcher.autoOff = true;
    watcher.outside = [];
    watcher.lastTime = Date.now();
    hidePauseBanner();
    enterPause(watcher);
    renderWalkedPath(true);
    toast('Still paused. Press Resume when you set off again.', 5000);
}

let pauseBannerMode = null, pauseBannerTimer = null;
function showPauseBanner(mode) {
    pauseBannerMode = mode;
    clearTimeout(pauseBannerTimer);
    setText($('pause-banner-text'), mode === 'resumed' ? 'Resumed: you’re back on the move.' : 'Still paused. Resume?');
    setText($('pause-banner-action'), mode === 'resumed' ? 'Undo' : 'Resume');
    $('pause-banner').hidden = false;
    // Undo stays offered for 2 minutes.
    if (mode === 'resumed') pauseBannerTimer = setTimeout(hideUndo, 120_000);
}

function hidePauseBanner(mode = null) {
    if (mode && pauseBannerMode !== mode) return;
    clearTimeout(pauseBannerTimer);
    pauseBannerMode = null;
    $('pause-banner').hidden = true;
}

function hideUndo() {
    hike.undo = null;
    hidePauseBanner('resumed');
}

$('pause-banner-action').addEventListener('click', () => {
    if (pauseBannerMode === 'resumed') undoResume();
    else resumeFromPause();
});
$('pause-banner-close').addEventListener('click', () => (pauseBannerMode === 'resumed' ? hideUndo() : hidePauseBanner()));

$('pause-btn').addEventListener('click', () => {
    if (pauseWatch) resumeFromPause();
    else pauseHike();
});

// ---------- Track Library: the recording's gaps, and choosing how each was filled ----------

function gapTitle(gap, i) {
    const t = new Date(gap.from.time);
    const pad = (n) => String(n).padStart(2, '0');
    return `Gap ${i + 1} · ${pad(t.getHours())}:${pad(t.getMinutes())} · ${formatGapDuration(gap.gapMs)}`;
}

function gapSummary(gap) {
    const n = gapNumbers(gap, settings.eleThresholdM);
    if (gap.status === 'pending') return `${formatDistance(n.distance)} straight for now (${gap.note})`;
    const how = gap.status === 'guess' ? `straight, a guess (${gap.note})` : GAP_SOURCES[gap.source];
    const others = gap.options.length - 1;
    return `${formatDistance(n.distance)} ${how}${others ? ` · ${others} other option${others > 1 ? 's' : ''}` : ''}`;
}

function renderGapList() {
    $('gap-section').hidden = gaps.length === 0;
    $('gap-list').replaceChildren(...gaps.map((gap, i) => {
        const row = document.createElement('div');
        row.className = 'gap-row';
        const label = Object.assign(document.createElement('span'), { textContent: `${gapTitle(gap, i)} · ${gapSummary(gap)}` });
        const show = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Show' });
        show.addEventListener('click', () => openGapReview(i));
        row.append(label, show);
        return row;
    }));
}

let reviewing = null; // index of the gap shown, or null

function openGapReview(i) {
    if (hike.running) return toast('Stop the hike first (Go › Stop): then each gap can be checked on the map.');
    reviewing = i;
    document.body.classList.add('gap-review');
    $('gap-review').hidden = false;
    renderGapReview();
}

function closeGapReview() {
    reviewing = null;
    document.body.classList.remove('gap-review');
    $('gap-review').hidden = true;
    view.setGapReview(null);
    renderLibrary();
}

function renderGapReview() {
    const gap = gaps[reviewing];
    if (!gap) return closeGapReview();
    setText($('gap-review-title'), `${gapTitle(gap, reviewing)} of ${gaps.length}`);
    const seconds = Math.max(1, gap.durationMs / 1000);
    const names = { route: 'Trail route', track: 'Along the track', straight: 'Straight line', short: 'Straight line' };
    let routeNo = 0;
    $('gap-review-options').replaceChildren(...gap.options.map((o, i) => {
        const name = o.source === 'route' ? `${names.route} ${++routeNo}` : names[o.source];
        const b = Object.assign(document.createElement('button'), {
            type: 'button',
            textContent: `${name} · ${formatDistance(o.distance)} · ${units.speed(o.distance / seconds)}` +
                (o.source === 'straight' && gap.options.length > 1 ? ' (a guess)' : ''),
        });
        b.setAttribute('aria-pressed', String(i === gap.chosen));
        b.addEventListener('click', () => chooseGapOption(i));
        return b;
    }));
    if (gap.status === 'pending' || gap.status === 'guess') {
        $('gap-review-options').append(Object.assign(document.createElement('p'), { className: 'hint', textContent: `Straight because: ${gap.note}.` }));
    }
    $('gap-prev').disabled = reviewing === 0;
    $('gap-next').disabled = reviewing === gaps.length - 1;
    view.setGapReview(gap.options.map((o, i) => ({ points: o.points, chosen: i === gap.chosen })));
}

function chooseGapOption(i) {
    const gap = gaps[reviewing];
    if (!gap || i === gap.chosen) return;
    gap.chosen = i;
    applyGap(gap);
    renderGapReview();
    toast(`Walked is now ${formatDistance(walkTotals().walked)}.`);
}

$('gap-prev').addEventListener('click', () => { reviewing = Math.max(0, reviewing - 1); renderGapReview(); });
$('gap-next').addEventListener('click', () => { reviewing = Math.min(gaps.length - 1, reviewing + 1); renderGapReview(); });
$('gap-done').addEventListener('click', closeGapReview);
view.on('click', (e) => {
    if (reviewing == null) return;
    const i = view.hitGapOption(e.point);
    if (i != null) chooseGapOption(i);
});

function onGeoError(err) {
    const status = $('gps-status');
    if (err.code === err.PERMISSION_DENIED) {
        stopHike();
        setStatus(status, 'GPS blocked', 'warn');
        toast('Location is blocked. On iPhone: Settings › Privacy & Security › Location Services › ' +
            'Safari Websites › "While Using the App", then reopen Trails.', 10_000);
    } else if (err.code === err.TIMEOUT) {
        setStatus(status, 'GPS still searching…', 'warn');
    } else {
        setStatus(status, 'No GPS signal', 'warn');
    }
}

function checkStaleFix() {
    if (!hike.lastFixAt) return;
    const age = Date.now() - hike.lastFixAt;
    if (age > STALE_FIX_MS) {
        setStatus($('gps-status'), `GPS: no fix for ${Math.round(age / 1000)} s`, 'warn');
    }
}

// Square loop starting at origin, going north, east, south and back, with a
// point every tenth of a side.
function squareLoop({ lat, lon }, sideM) {
    const dLat = sideM / 111320;
    const dLon = sideM / (111320 * Math.cos(lat * Math.PI / 180));
    const corners = [[0, 0], [dLat, 0], [dLat, dLon], [0, dLon], [0, 0]];
    const points = [];
    for (let c = 0; c < corners.length - 1; c++) {
        for (let s = 0; s < 10; s++) {
            const f = s / 10;
            points.push({
                lat: lat + corners[c][0] + f * (corners[c + 1][0] - corners[c][0]),
                lon: lon + corners[c][1] + f * (corners[c + 1][1] - corners[c][1]),
                ele: null,
            });
        }
    }
    points.push({ lat, lon, ele: null });
    return points;
}

// Free recording has no track to replay: walk a 2 km square from where the
// recording left off (so Stop/Start and Resume carry on there), else the map centre.
function freeSimRoute() {
    const last = path.segments.flat().at(-1);
    return buildTrack(squareLoop(last ?? hike.lastFix ?? view.getCenter(), 500));
}

// Replays route (the loaded track, or a test square in free recording) at
// SIM_SPEEDUP × walking pace (1.4 m/s), one fix per second, with realistic GPS
// noise (±4 m scatter, accuracy 5–15 m, an occasional ±45 m fix that must be
// discarded), a 45 s stop at 15% of the way and a detour of up to 120 m to the
// side at 30–38%.
function startSimulation(route) {
    const speed = 1.4 * SIM_SPEEDUP;
    const stopAt = route.total * 0.15;
    const detourStart = route.total * 0.30;
    const detourEnd = route.total * 0.38;
    // Continue from the current progress (after Stop/Start or a resumed hike).
    let along = route === track ? hike.progress?.along ?? 0 : 0, tick = 0;
    let stopLeft = along > stopAt ? 0 : 45;
    const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());

    hike.simTimer = setInterval(() => {
        tick++;
        const skipping = Date.now() < hike.simGapUntil; // Settings › Testing › Simulate a GPS gap
        if (pauseWatch && !hike.simHoldUntil) hike.simHoldUntil = Date.now() + 60_000;
        if (!pauseWatch) hike.simHoldUntil = 0;
        if (Date.now() < hike.simHoldUntil) { /* a picnic: stand still */ }
        else if (along >= stopAt && stopLeft > 0) stopLeft--;
        else along = Math.min(route.total, along + speed);

        const p = pointAtDistance(route, along);
        let side = 0;
        if (along > detourStart && along < detourEnd) {
            const f = (along - detourStart) / (detourEnd - detourStart);
            side = 120 * (1 - Math.abs(2 * f - 1));
        }
        // Shift sideways, perpendicular to the current segment, then add noise.
        const a = route.points[p.index], b = route.points[p.index + 1];
        const cosLat = Math.cos(p.lat * Math.PI / 180);
        const dx = (b.lon - a.lon) * cosLat, dy = b.lat - a.lat;
        const len = Math.hypot(dx, dy) || 1;
        const north = (dx / len) * side + 4 * gauss();
        const east = -(dy / len) * side + 4 * gauss();
        const accuracy = tick % 15 === 0 ? 45 : 5 + 10 * Math.random();
        if (!skipping) onFix({
            coords: {
                latitude: p.lat + north / 111320,
                longitude: p.lon + east / (111320 * cosLat),
                accuracy,
            },
        });
        if (along >= route.total) {
            clearInterval(hike.simTimer);
            hike.simTimer = null;
            toast('Simulation finished.');
        }
    }, 1000);
}

function startHike() {
    if (!SIMULATE && !('geolocation' in navigator)) {
        toast('This browser cannot access GPS.');
        return;
    }
    unlockAudio();
    hike.running = true;
    view.setFollow(true);
    $('start-btn').textContent = 'Stop';
    $('start-btn').classList.add('running');
    renderTrackStatus();
    setStatus($('gps-status'), SIMULATE ? 'Simulating GPS' : 'Waiting for GPS…', 'warn');
    requestWakeLock();
    motion.start(Date.now());
    // A Stop..Start is a pause you chose: a new segment, and no gap. After a
    // force-close, Resume carries on the segment and the closed time is a gap.
    if (!hike.continueSegment) {
        path.startSegment();
        hike.lastGood = null;
    }
    hike.continueSegment = false;
    if (SIMULATE) {
        startSimulation(track ?? freeSimRoute());
    } else {
        hike.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 30_000,
        });
    }
    // Once a second: running clocks (moving/stopped timer) and the stale-GPS check.
    let ticks = 0;
    hike.clockTimer = setInterval(() => {
        renderWalk();
        checkStaleFix();
        if (++ticks % RECORDING_SAVE_EVERY_S === 0) saveRecording();
        if (ticks % 60 === 0) retryGaps();
    }, 1000);
    renderWalk();
    resetIdleTimer();
    saveRecording();
}

// Stop pauses the recording; Start continues it (Track Library › Reset walked/time).
function stopHike() {
    if (hike.watchId != null) navigator.geolocation.clearWatch(hike.watchId);
    clearInterval(hike.simTimer);
    clearInterval(hike.clockTimer);
    clearTimeout(idleTimer);
    hike.watchId = hike.simTimer = hike.clockTimer = null;
    hike.running = false;
    hike.lastFixAt = 0;
    endPause();
    motion.pause(Date.now());
    smoother.reset();
    climb.pause();
    rates.clear();
    hike.ele = {};
    hike.lastGood = null;
    debug.eles = [];
    renderWalk();
    renderWalkedPath(true);
    saveRecording();
    releaseWakeLock();
    exitDim();
    resetOffTrack();
    $('start-btn').textContent = 'Start';
    $('start-btn').classList.remove('running');
    renderTrackStatus();
    setStatus($('gps-status'), 'GPS off');
    renderStats();
}

$('start-btn').addEventListener('click', () => {
    if (hike.running) {
        stopHike();
        showFinish();
    } else {
        hideFinish();
        startHike();
    }
});

$('center-btn').addEventListener('click', () => {
    if (view.centerOnPosition()) return;
    if (track) view.fitTrack(track.points);
    else toast('Press Start to show your position.');
});

// ---------- Settings dialog ----------

async function fillDeviceInfo() {
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    setText($('info-mode'), standalone ? 'Home Screen app' : 'Browser tab');
    setText($('info-wakelock'), 'wakeLock' in navigator ? 'Supported' : 'Not supported');
    setText($('info-wakelock-inline'), 'wakeLock' in navigator ? 'supported' : 'not supported');
    setText($('info-vibrate'), 'vibrate' in navigator ? 'Supported' : 'Not available (normal on iPhone)');
    try {
        const persisted = await navigator.storage?.persisted?.();
        const estimate = await navigator.storage?.estimate?.();
        const usedMb = estimate ? (estimate.usage / 1e6).toFixed(1) : '?';
        setText($('info-storage'), `${usedMb} MB used · ${persisted ? 'protected from cleanup' : 'not protected'}`);
    } catch {
        setText($('info-storage'), 'Unknown');
    }
    navigator.serviceWorker?.controller?.postMessage({ type: 'GET_VERSION' });
}

// Fills the Settings page with the current values (each time it is shown).
function fillSettings() {
    $('set-units').value = units.system;
    for (const id of Object.keys(LENGTH_FIELDS)) showLengthSetting(id);
    $('set-steep').value = settings.steepSlopeDeg;
    $('set-alerts').value = settings.alertMode;
    $('set-vspeed').value = settings.vSpeedPer;
    $('set-gap-speed').value = units.speedToInput(settings.gapMaxSpeedMps);
    for (const el of document.querySelectorAll('.u-speed')) el.textContent = units.speedUnit;
    demStoreCount().then((n) => setText($('dem-store-count'), n == null ? 'not supported here' : `${n} tiles`));
    $('set-autodim').value = String(settings.autoDimS);
    $('set-window').value = settings.smoothWindow;
    $('set-stoptime').value = settings.stopTimeS;
    $('set-debug').checked = settings.debug;
    $('set-simulate').checked = SIMULATE;
    $('set-simulate').disabled = params.has('sim');
    for (const el of document.querySelectorAll('.u-len')) el.textContent = units.lengthUnit;
    fillDeviceInfo();
}

// Number fields: clamp to the field's min/max, save, then apply.
function bindNumberSetting(id, key, apply) {
    $(id).addEventListener('change', (e) => {
        const { min, max } = e.target;
        const value = Number(e.target.value);
        settings[key] = Number.isFinite(value) && e.target.value !== ''
            ? Math.min(Number(max), Math.max(Number(min), value))
            : DEFAULT_SETTINGS[key];
        e.target.value = settings[key];
        saveSettings();
        apply?.();
    });
}

// Length fields are typed in m or ft (Settings › Units) and kept in metres:
// id -> [setting, min m, max m, step in m, step in ft].
const LENGTH_FIELDS = {
    'set-offtrack': ['offTrackM', 10, 500, 5, 10],
    'set-offtrack-straight': ['offTrackStraightM', 10, 1000, 10, 25],
    'set-maxacc': ['maxAccuracyM', 5, 100, 5, 10],
    'set-stopradius': ['stopRadiusM', 5, 50, 1, 5],
    'set-stopclimb': ['stopClimbM', 1, 20, 0.5, 1],
    'set-elethreshold': ['eleThresholdM', 0, 20, 1, 1],
    'set-pause-radius': ['pauseRadiusM', 30, 1000, 10, 25],
};
const lengthStep = (id) => LENGTH_FIELDS[id][units.system === 'imperial' ? 4 : 3];

function showLengthSetting(id) {
    const [key, minM, maxM] = LENGTH_FIELDS[id];
    const step = lengthStep(id);
    Object.assign($(id), {
        min: units.toInput(minM, step),
        max: units.toInput(maxM, step),
        step,
        value: units.toInput(settings[key], step),
    });
}

function bindLengthSetting(id, apply) {
    const [key, minM, maxM] = LENGTH_FIELDS[id];
    $(id).addEventListener('change', (e) => {
        const typed = Number(e.target.value);
        settings[key] = Number.isFinite(typed) && e.target.value !== ''
            ? Math.min(maxM, Math.max(minM, units.fromInput(typed)))
            : DEFAULT_SETTINGS[key];
        // Metric values stay whole metres (or half metres for the climb).
        if (units.system === 'metric') settings[key] = Math.round(settings[key] / lengthStep(id)) * lengthStep(id);
        showLengthSetting(id);
        saveSettings();
        apply?.();
    });
}

const applyTracking = () => {
    smoother.configure({ maxAccuracyM: settings.maxAccuracyM, windowSize: settings.smoothWindow });
    motion.configure({ stopRadiusM: settings.stopRadiusM, stopTimeS: settings.stopTimeS, stopClimbM: settings.stopClimbM });
};
bindLengthSetting('set-maxacc', applyTracking);
bindNumberSetting('set-window', 'smoothWindow', applyTracking);
bindLengthSetting('set-stopradius', applyTracking);
bindNumberSetting('set-stoptime', 'stopTimeS', applyTracking);
bindLengthSetting('set-stopclimb', applyTracking);
bindLengthSetting('set-offtrack');
bindLengthSetting('set-pause-radius');
bindLengthSetting('set-offtrack-straight');
bindNumberSetting('set-steep', 'steepSlopeDeg', () => planner.refresh());

// Everything shown in km/m switches to mi/ft (and back) at once.
$('set-units').addEventListener('change', (e) => {
    settings.units = e.target.value;
    units = makeUnits(settings.units);
    saveSettings();
    fillSettings();
    renderTrackStatus();
    renderStats();
    renderDebug();
    chart.redraw();
    planner.refresh();
});

$('router-credit').textContent = ROUTER_ATTRIBUTION;
$('geocoder-credit').textContent = GEOCODER_ATTRIBUTION;
bindLengthSetting('set-elethreshold', () => {
    climb.thresholdM = settings.eleThresholdM; // from the next climb or drop on
    if (track) track.profile = buildProfile(track, settings.eleThresholdM);
    showProfile();
});

$('set-debug').addEventListener('change', (e) => {
    settings.debug = e.target.checked;
    saveSettings();
    if (!settings.debug) view.setDebug(null);
    renderDebug();
});

// Switching GPS source needs a fresh start; not offered mid-hike.
$('set-simulate').addEventListener('change', (e) => {
    if (hike.running) {
        e.target.checked = SIMULATE;
        return toast('Stop the hike first.');
    }
    settings.simulate = e.target.checked;
    saveSettings();
    location.reload();
});

// No fixes for a minute while the simulation walks on: the app sees a gap, as after
// the phone was locked (except that the clocks keep ticking).
hike.simGapUntil = 0;
$('sim-gap-btn').addEventListener('click', () => {
    if (!SIMULATE || !hike.running) return toast('Turn on Simulated GPS and press Go › Start first.');
    hike.simGapUntil = Date.now() + 60_000;
    showTab('go');
    toast('No GPS for 1 minute: the gap is filled when fixes come back.', 4000);
});

$('reset-trip-btn').addEventListener('click', async () => {
    if (walkUnsaved()) {
        if (await keepRecording('Resetting walked/time')) resetTrip();
    } else if (confirm('Reset walked distance and moving/stopped time to zero?')) {
        resetTrip();
    }
});

$('set-alerts').addEventListener('change', (e) => {
    settings.alertMode = e.target.value;
    saveSettings();
    if (alertMode() === 'sound') {
        unlockAudio();
        beep(); // lets you check the volume right away
    }
    renderAlertToggle();
    renderStats();
});

$('set-gap-speed').addEventListener('change', (e) => {
    const typed = Number(e.target.value);
    const mps = Number.isFinite(typed) && e.target.value !== '' ? units.speedFromInput(typed) : DEFAULT_GAP_MAX_SPEED_MPS;
    settings.gapMaxSpeedMps = Math.min(20 / 3.6, Math.max(2 / 3.6, mps));
    e.target.value = units.speedToInput(settings.gapMaxSpeedMps);
    saveSettings();
});

$('set-vspeed').addEventListener('change', (e) => {
    settings.vSpeedPer = e.target.value;
    saveSettings();
    renderWalk();
});

$('dem-clear-btn').addEventListener('click', async () => {
    if (!confirm('Clear the elevation tiles stored on this device? They are downloaded again when needed (with signal).')) return;
    await clearDemStore();
    fillSettings();
    toast('Stored elevation tiles cleared.');
});

$('set-autodim').addEventListener('change', (e) => {
    settings.autoDimS = Number(e.target.value);
    saveSettings();
    resetIdleTimer();
});

$('reverse-btn').addEventListener('click', () => {
    if (!track) return toast('No track loaded.');
    setTrack(track.name, track.points.slice().reverse(), { eleInfo: track.eleInfo, temporary: track.temporary, waypoints: track.waypoints });
    toast('Track direction reversed.');
});

// ---------- GPX export ----------

// iPhone/iPad and Mac Safari: the Share sheet (Save to Files, AirDrop, Messages).
// Elsewhere, or if sharing is refused: a normal download.
// Must run straight from the tap: Safari only shares inside a user gesture.
// Resolves false if the user closed the Share sheet without sharing.
async function exportGpx(text, fileName, title) {
    const file = new File([text], fileName, { type: 'application/gpx+xml' });
    if (navigator.canShare?.({ files: [file] })) {
        try {
            await navigator.share({ files: [file], title });
            return true;
        } catch (err) {
            if (err.name === 'AbortError') return false; // the user closed the sheet
        }
    }
    downloadFile(file);
    return true;
}

function downloadFile(file) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    toast(`Downloaded ${file.name}`);
}

$('export-track-btn').addEventListener('click', () => {
    if (!track) return toast('No track loaded.');
    const name = track.name || 'Track';
    exportGpx(buildGpx({ name, desc: totalsText(track, track.profile), segments: [track.points], waypoints: track.waypoints }), gpxFileName(name), name);
});

$('export-hike-btn').addEventListener('click', () => exportHike());

async function exportHike() {
    if (path.pointCount < 2) {
        toast('Nothing recorded yet: press Start and walk a little.');
        return false;
    }
    const start = path.startTime;
    const base = track?.name || 'Free recording';
    const name = track ? `${base} (walked)` : base;
    // Free recordings (or a track without elevations): say so, to fill from a DEM later.
    const totals = walkTotals();
    const walked = `Walked ${formatDistance(totals.walked)}, moving ${formatDuration(totals.movingMs)}`;
    let desc = path.hasElevations
        ? `${walked}, ascent ${formatMetres(totals.ascent)}, descent ${formatMetres(totals.descent)}`
        : `${walked}. ${NO_ELEVATION_DESC}`;
    if (totals.pausedMs > 0) desc += `, paused ${formatDuration(totals.pausedMs)}`;
    if (gaps.length) desc += `. ${gaps.length} recording gap${gaps.length > 1 ? 's' : ''} filled by guessing the way (segments whose points say "Gap filled", without a GPS fix)`;
    const pointCount = path.pointCount;
    const exported = await exportGpx(buildGpx({ name, desc, segments: exportSegments(), time: start }),
        gpxFileName(track ? `${base} walked` : base, start), name);
    if (exported) markWalkSaved(pointCount);
    return exported;
}

// The recorded path for GPX export: each filled gap is a segment of its own, its
// points labelled with what filled it (<type>) and the filled ones marked <fix>none</fix>.
function exportSegments() {
    return splitGaps(path.snapshot()).map((run) => {
        if (run.gap == null) return run.points;
        const gap = gaps.find((g) => g.id === run.gap);
        const how = !gap ? 'a straight line' : gap.status === 'pending' ? 'a straight line, not filled yet'
            : gap.source === 'route' ? 'a trail route (a guess)' : gap.source === 'track' ? 'the planned track'
                : gap.status === 'guess' ? 'a straight line (a guess)' : 'a straight line (short)';
        return run.points.map((p) => ({ ...p, type: `Gap filled with ${how}`, fix: p.gap ? 'none' : undefined }));
    });
}

// ---------- Keeping recordings: Save as track, saved walks, "keep it?" ----------

// A recorded walk (with or without a track) is protected until exported or saved
// as a track (more points recorded since count as unsaved again).
function walkUnsaved() {
    return path.pointCount >= 2 && path.pointCount !== hike.savedPoints;
}

function markWalkSaved(pointCount = path.pointCount) {
    hike.savedPoints = pointCount;
    saveRecording();
    renderWalk();
}

// Asks before an action that clears a recording that is neither exported nor
// saved. Resolves true to go ahead (exported, saved or discarded).
function keepRecording(action) {
    if (!walkUnsaved()) return Promise.resolve(true);
    setText($('keep-details'),
        `Your walk (${formatDistance(walkTotals().walked)}, moving ${formatDuration(walkTotals().movingMs)}` +
        `${track ? ` along “${track.name || 'the track'}”` : ', no track'}) hasn't been exported or saved as a track. ` +
        `${action} clears it.`);
    const dialog = $('keep-dialog');
    dialog.showModal();
    return new Promise((resolve) => {
        const done = (ok) => {
            dialog.close();
            resolve(ok);
        };
        // Export runs straight from the tap (needed for the Share sheet); closing
        // the sheet without sharing leaves the question open.
        $('keep-export').onclick = async () => { if (await exportHike()) done(true); };
        $('keep-save').onclick = async () => {
            $('keep-save').disabled = true;
            const saved = await saveWalkEntry();
            $('keep-save').disabled = false;
            if (saved) done(true);
        };
        $('keep-discard').onclick = () => done(true);
        $('keep-cancel').onclick = () => done(false);
        dialog.oncancel = () => resolve(false); // Escape key
    });
}

// The recorded path as one line of track points (Start..Stop segments joined,
// the doubled stop centres removed).
function walkedPoints() {
    const points = [];
    for (const p of path.segments.flat()) {
        const prev = points[points.length - 1];
        if (prev && prev.lat === p.lat && prev.lon === p.lon) continue;
        points.push({ lat: p.lat, lon: p.lon, ele: p.ele });
    }
    return points;
}

const loadLibrary = async () => (await kvGet('library')) || [];

// Adds an entry to the Track Library, or replaces the one with the same id (an
// edited track). keepVersion (a reason): the replaced one is kept for Restore.
async function saveLibraryEntry(entry, { keepVersion = null } = {}) {
    const entries = await loadLibrary();
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i >= 0 && keepVersion) entries[i] = withNewVersion(entries[i], entry, Date.now(), keepVersion);
    else if (i >= 0) entries[i] = entry;
    else entries.push(entry);
    await kvSet('library', entries);
    requestPersistence();
}

// Plan tab: entry is a library entry (or { name, points }) to edit, or nothing for a new track.
function openPlanner(entry = null) {
    if (hike.running) return toast('Stop the hike first (Go › Stop): planning replaces the map you are following.');
    showTab('plan');
    planner.open(entry);
}

$('new-track-btn').addEventListener('click', () => openPlanner(planFromEnds()));
$('lib-new-track-btn').addEventListener('click', () => openPlanner());
$('guide-btn').addEventListener('click', () => {
    if (hike.running) return toast('Stop the hike first (Go › Stop): importing replaces the map you are following.');
    guideImport.open();
});
// A loaded GPX (or walk) is edited like a recorded walk: a new track, the original kept.
$('edit-loaded-btn').addEventListener('click', () => {
    if (!track) return toast('No track loaded: load one from the Track Library first.');
    openPlanner({ name: track.name || 'Track', points: track.points, waypoints: track.waypoints });
});

// The loaded track's Track Library entry (not the test loop), if it is there.
function loadedTrackEntry(entries) {
    if (!track || track.temporary) return null;
    const key = trackKey();
    return entries.find((e) => entryKind(e) === 'track' && trackKeyOf({ name: e.name, points: e.points, total: buildTrack(e.points).total }) === key) ?? null;
}

// The recording as a walk in the Track Library: one entry per recording, saved
// on every Stop (and by Save walk), linked to the loaded track when that is in
// the library. Elevations: the DEM's, recorded as you walked; points recorded
// with no signal get them now, if the DEM can be reached.
async function saveWalkEntry({ quiet = false } = {}) {
    const points = walkedPoints();
    if (points.length < 2) {
        if (!quiet) toast('Nothing recorded yet: press Start and walk a little.');
        return null;
    }
    const pointCount = path.pointCount;
    const name = track ? `${track.name} (walked ${formatDateTime(path.startTime)})` : `Walk ${formatDateTime(path.startTime)}`;
    const own = points.filter((p) => Number.isFinite(p.ele)).length;
    if (!quiet) toast(`Saving “${name}”: getting elevations from the DEM…`, 20_000);
    let result = null;
    if (own < points.length) {
        try {
            result = await fillElevationsFromDem(points);
        } catch (err) {
            console.error('DEM elevations failed:', err);
        }
    }
    const dem = result?.filled ?? 0;
    const missing = points.length - own - dem;
    const t = walkTotals();
    let entry;
    try {
        const entries = await loadLibrary();
        const existing = hike.walkId ? entries.find((e) => e.id === hike.walkId) : null;
        const trackEntry = loadedTrackEntry(entries);
        const fields = {
            kind: 'walk',
            points: result?.points ?? points,
            eleInfo: { own, dem, missing, status: !missing ? 'ok' : result?.tooLarge ? 'tooLarge' : 'failed' },
            trackId: trackEntry?.id ?? existing?.trackId ?? null,
            trackName: track && !track.temporary ? track.name : existing?.trackName ?? null,
            stats: { walked: t.walked, movingMs: t.movingMs, stoppedMs: t.stoppedMs, pausedMs: t.pausedMs, ascent: t.ascent, descent: t.descent, gaps: gaps.length },
            recordedAt: path.startTime,
            edited: false,
        };
        const now = Date.now();
        // Walked on after an edit: the whole recording again, the edit kept as a version.
        entry = existing?.edited ? withNewVersion(existing, fields, now, 'walked on after an edit')
            : { ...(existing ?? { id: `walk-${now}`, name }), ...fields, savedAt: now };
        hike.walkId = entry.id;
        await saveLibraryEntry(entry);
    } catch (err) {
        console.error('Saving walk failed:', err);
        toast('Could not save the walk on this device: export it instead.', 5000);
        return null;
    }
    markWalkSaved(pointCount);
    renderLibrary();
    if (!quiet) {
        toast(`Saved “${entry.name}” in the Track Library › Walks. ` +
            (missing ? `${missing} points still need elevations (offline?): they are fetched when you load it.` : 'Elevations from the DEM.'), 7000);
    }
    return entry;
}

// The recording's walk entry (saved now if it isn't yet).
async function currentWalkEntry() {
    const entries = await loadLibrary();
    return (hike.walkId && entries.find((e) => e.id === hike.walkId)) || saveWalkEntry({ quiet: true });
}

$('save-walk-btn').addEventListener('click', () => saveWalkEntry());
$('save-walk-lib-btn').addEventListener('click', () => saveWalkEntry());

// ---------- Walk finished (Go › Stop): the walk is saved; edit it, make a track, update the track ----------

let editing = null;   // the walk entry being edited

async function showFinish() {
    if (path.pointCount < 2) return; // nothing recorded
    document.body.classList.add('walk-finished');
    $('finish-box').hidden = false;
    closeWalkEdit();
    renderFinish('Saving in the Track Library…');
    const entry = await saveWalkEntry({ quiet: true });
    renderFinish(entry ? `Saved in Track Library › Walks as “${entry.name}”.` : 'Could not save it on this device: Export it.', entry);
}

function hideFinish() {
    if ($('finish-box').hidden) return;
    closeWalkEdit();
    document.body.classList.remove('walk-finished');
    $('finish-box').hidden = true;
}

async function renderFinish(savedText, entry = null) {
    const t = walkTotals();
    setText($('finish-summary'), `${formatDistance(t.walked)} · moving ${formatDuration(t.movingMs)} · stopped ${formatDuration(t.stoppedMs)}` +
        (t.pausedMs > 0 ? ` · paused ${formatDuration(t.pausedMs)}` : '') +
        ` · ↑ ${formatMetres(t.ascent)} ↓ ${formatMetres(t.descent)}` +
        (gaps.length ? ` · ${gaps.length} gap${gaps.length > 1 ? 's' : ''} filled` : ''));
    setText($('finish-saved'), savedText);
    $('finish-gaps-btn').hidden = !gaps.length;
    setText($('finish-gaps-btn'), `Review gaps (${gaps.length})`);
    const target = entry?.trackId ? (await loadLibrary()).find((e) => e.id === entry.trackId) : null;
    $('finish-update-btn').hidden = !target;
    if (target) setText($('finish-update-btn'), `Update “${target.name}”`);
    for (const id of ['finish-edit-btn', 'finish-track-btn', 'finish-update-btn']) $(id).disabled = !entry;
}

$('finish-done').addEventListener('click', () => hideFinish());
$('finish-continue').addEventListener('click', () => {
    hideFinish();
    startHike();
});
$('finish-export-btn').addEventListener('click', () => exportHike());
$('finish-gaps-btn').addEventListener('click', () => {
    hideFinish();
    showTab('library');
    openGapReview(0);
});
$('finish-discard-btn').addEventListener('click', async () => {
    if (!confirm('Discard this walk? It is deleted from the Track Library and the recording is cleared. This can\'t be undone.')) return;
    const id = hike.walkId;
    if (id) await kvSet('library', (await loadLibrary()).filter((e) => e.id !== id));
    hideFinish();
    discardRecording();
    renderLibrary();
    toast('Walk discarded.');
});

// A new track from the walk (as it is now, edited or not); the walk stays.
$('finish-track-btn').addEventListener('click', async () => {
    const walk = await currentWalkEntry();
    if (!walk) return;
    const entry = { id: `track-${Date.now()}`, kind: 'track', name: `${walk.name} · track`, points: walk.points, eleInfo: walk.eleInfo, fromWalk: walk.id, savedAt: Date.now() };
    await saveLibraryEntry(entry);
    renderLibrary();
    toast(`Made the track “${entry.name}” (Track Library › Tracks). Load it there to follow it, or Edit it in Plan.`, 6000);
});

// The track you followed becomes this walk; its current version is kept for Restore.
$('finish-update-btn').addEventListener('click', async () => {
    const walk = await currentWalkEntry();
    const entries = await loadLibrary();
    const old = walk?.trackId ? entries.find((e) => e.id === walk.trackId) : null;
    if (!old) return toast('The track is no longer in the Track Library.');
    if (!confirm(`Replace “${old.name}” (${formatDistance(buildTrack(old.points).total)}) with this walk (${formatDistance(buildTrack(walk.points).total)})? ` +
        'Its current version is kept: Track Library › Restore brings it back. Its waypoints stay where they are.')) return;
    const wasLoaded = loadedTrackEntry(entries)?.id === old.id;
    const updated = withNewVersion(old, { points: walk.points, eleInfo: walk.eleInfo, plan: null, updatedFrom: walk.id }, Date.now(), `updated with the walk of ${formatDateTime(walk.recordedAt ?? walk.savedAt)}`);
    delete updated.plan;
    await saveLibraryEntry(updated);
    if (wasLoaded) {
        await setTrack(updated.name, updated.points, { eleInfo: updated.eleInfo, waypoints: updated.waypoints });
        saveRecording();
    }
    renderLibrary();
    toast(`Updated “${old.name}” with this walk. Track Library › Restore brings the old version back.`, 6000);
});

// ---------- Walk finished › Edit walk: trim, cut out, simplify, snap to trails ----------

const EDIT_RANGES = ['edit-trim-start', 'edit-trim-end', 'edit-cut-from', 'edit-cut-to'];

$('finish-edit-btn').addEventListener('click', async () => {
    const walk = await currentWalkEntry();
    if (!walk) return;
    editing = walk;
    const total = Math.round(cumulative(walk.points).at(-1));
    const step = Math.max(1, Math.round(total / 500));
    for (const id of EDIT_RANGES) Object.assign($(id), { max: total, step, value: 0 });
    $('edit-cut-from').value = Math.round(total * 0.4);
    $('edit-cut-to').value = Math.round(total * 0.6);
    $('edit-cut-on').checked = false;
    $('edit-cut').hidden = true;
    $('edit-simplify').value = '0';
    $('finish-main').hidden = true;
    $('finish-edit').hidden = false;
    view.setWalked([]); // the preview replaces the pink line
    updateWalkEdit(true);
});

function closeWalkEdit() {
    if (!editing) return;
    editing = null;
    $('finish-main').hidden = false;
    $('finish-edit').hidden = true;
    view.setEditPreview(null);
    renderWalkedPath(true);
}

function currentEdit() {
    const v = (id) => Number($(id).value);
    return editWalk(editing.points, {
        trimStartM: v('edit-trim-start'),
        trimEndM: v('edit-trim-end'),
        cut: $('edit-cut-on').checked ? { fromM: v('edit-cut-from'), toM: v('edit-cut-to') } : null,
        simplifyM: v('edit-simplify'),
    });
}

function updateWalkEdit(fit = false) {
    if (!editing) return;
    for (const id of EDIT_RANGES) setText($(`${id}-out`), formatDistance(Number($(id).value)));
    $('edit-cut').hidden = !$('edit-cut-on').checked;
    for (const id of ['edit-cut-from', 'edit-cut-to']) $(id).disabled = !$('edit-cut-on').checked;
    const r = currentEdit();
    // Zoomed to the walk above the box (and the Start bar under it).
    const mapBottom = $('map').getBoundingClientRect().bottom;
    view.setEditPreview(r.points, r.removed, { fit, bottom: Math.max(60, mapBottom - $('finish-box').getBoundingClientRect().top + 20) });
    const ok = r.points.length >= 2 && r.length > 0;
    const snap = ok ? snapPlan(r.points) : null;
    setText($('edit-result'), ok ? `Kept ${formatDistance(r.length)} of ${formatDistance(r.original)} · ${r.points.length} points` : 'Nothing left: trim less.');
    $('edit-save').disabled = !ok;
    $('edit-snap').disabled = !ok;
    setText($('edit-snap'), snap ? `Snap to trails (${snap.requests} request${snap.requests === 1 ? '' : 's'})` : 'Snap to trails');
}

for (const id of [...EDIT_RANGES, 'edit-simplify']) $(id).addEventListener('input', () => updateWalkEdit());
// The box grows or shrinks: zoom again so the walk stays above it.
$('edit-cut-on').addEventListener('change', () => updateWalkEdit(true));
$('edit-back').addEventListener('click', () => closeWalkEdit());

// The edited walk replaces the walk; the earlier version is kept (Track Library › Restore).
$('edit-save').addEventListener('click', async () => {
    const r = currentEdit();
    const own = r.points.filter((p) => Number.isFinite(p.ele)).length;
    const updated = withNewVersion(editing, {
        points: r.points,
        eleInfo: { own, dem: 0, missing: r.points.length - own, status: 'ok' },
        edited: true,
        stats: { ...editing.stats, walked: r.length },
    }, Date.now(), 'edited (trimmed, cut or simplified)');
    await saveLibraryEntry(updated);
    renderLibrary();
    closeWalkEdit();
    toast(`Saved the edited walk (${formatDistance(r.length)}). Track Library › Restore brings the recorded one back.`, 6000);
});

// Opens Plan with the edited walk as points on trail segments, each routed (one
// request per segment); Save there makes a new track linked to the walk.
$('edit-snap').addEventListener('click', () => {
    const r = currentEdit();
    const plan = snapPlan(r.points);
    if (!routingAvailable()) return toast('Trail routing isn\'t set up: the segments would stay straight.');
    const name = `${editing.name} · on trails`;
    const fromWalk = editing.id;
    hideFinish();
    openPlanner({ name, plan: { vertices: plan.vertices, segments: plan.segments, routes: plan.routes }, fromWalk });
    toast(`Finding trails: ${plan.requests} routing request${plan.requests === 1 ? '' : 's'}. Check the line, then Save.`, 6000);
});

// Keeps the loaded track (e.g. the sample, or one restored from before v0.10)
// in the library too.
$('keep-track-btn').addEventListener('click', async () => {
    if (!track) return toast('No track loaded.');
    try {
        await saveLibraryEntry({ id: `track-${Date.now()}`, name: track.name || 'Track', points: track.points, eleInfo: track.eleInfo, waypoints: track.waypoints, savedAt: Date.now() });
        renderLibrary();
        toast(`Added “${track.name || 'Track'}” to the Track Library.`);
    } catch (err) {
        console.error('Saving track failed:', err);
        toast('Could not save the track on this device.', 5000);
    }
});

// The Track Library's lines about the loaded track and the current recording.
function renderLibraryStatus() {
    setText($('lib-loaded'), track
        ? `${track.name || 'Track'} · ${formatDistance(track.total)}${track.temporary ? ' · temporary test track' : ''}`
        : 'None: load one above, or import a GPX.');
    const unload = $('lib-unload-btn');
    unload.hidden = !track;
    unload.textContent = track?.temporary ? 'Remove test loop' : 'Unload track';
    const recorded = path.pointCount >= 2;
    setText($('lib-recording'), recorded
        ? `Walked ${formatDistance(walkTotals().walked)} · moving ${formatDuration(walkTotals().movingMs)}` +
          `${track ? ` along “${track.name || 'the track'}”` : ' (free recording)'}` +
          `${hike.running ? ' · recording now' : ''}${walkUnsaved() ? ' · not exported or saved yet' : ' · saved'}`
        : 'Nothing recorded. Go › Start records a walk.');
    renderGapList();
}

async function renderLibrary() {
    let entries = [];
    try {
        entries = await loadLibrary();
    } catch (err) {
        console.error('Loading saved walks failed:', err);
    }
    const links = libraryLinks(entries);
    const byId = new Map(entries.map((e) => [e.id, e]));
    const newestFirst = entries.slice().reverse();
    const tracks = newestFirst.filter((e) => entryKind(e) === 'track');
    const walks = newestFirst.filter((e) => entryKind(e) === 'walk');
    $('library').replaceChildren(...tracks.map((e) => libraryRow(e, links, byId)));
    $('library-walks').replaceChildren(...walks.map((e) => libraryRow(e, links, byId)));
    $('library-empty').hidden = tracks.length > 0;
    $('library-walks-empty').hidden = walks.length > 0;
    renderLibraryStatus();
}

// One Track Library entry: name, distance, Load / Edit / Export / Delete, and a line with
// its links (a walk's track, a track's walks) and Restore when an earlier version is kept.
function libraryRow(entry, links, byId) {
    const row = document.createElement('div');
    row.className = 'library-row';
    const label = document.createElement('span');
    const { total } = buildTrack(entry.points);
    const entryKey = trackKeyOf({ name: entry.name, points: entry.points, total });
    const isLoaded = () => entryKey === trackKey();
    const stops = entry.waypoints?.length ? ` · ${entry.waypoints.length} waypoints` : '';
    label.textContent = `${entry.name} · ${formatDistance(total)}${stops}${isLoaded() ? ' · loaded' : ''}`;
    const load = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Load' });
    load.addEventListener('click', async () => {
        if (!await keepRecording(`Loading “${entry.name}”`)) return;
        hideFinish();
        await setTrack(entry.name, entry.points, { eleInfo: entry.eleInfo, waypoints: entry.waypoints });
        resetTrip();
        showTab('go');
        toast(`Loaded ${formatDistance(track.total)} ${entryKind(entry) === 'walk' ? 'walk' : 'track'}: Start to follow it.`);
    });
    const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Edit' });
    edit.addEventListener('click', () => openPlanner(entry));
    // Export straight from the library, without loading it (a walk is marked as one, so a
    // re-import puts it back under Walks).
    const exp = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Export' });
    exp.addEventListener('click', () => {
        const t = buildTrack(entry.points);
        const desc = totalsText(t, buildProfile(t, settings.eleThresholdM));
        exportGpx(buildGpx({ name: entry.name, desc, type: entryKind(entry) === 'walk' ? 'walk' : '', segments: [entry.points], waypoints: entry.waypoints ?? [] }),
            gpxFileName(entry.name), entry.name);
    });
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'danger', textContent: 'Delete' });
    del.addEventListener('click', async () => {
        const loaded = isLoaded();
        if (!confirm(`Delete “${entry.name}” from this device?` +
            (loaded && !hike.running ? ' It is loaded now, so it is unloaded too.' : ''))) return;
        await kvSet('library', (await loadLibrary()).filter((e) => e.id !== entry.id));
        if (entry.id === hike.walkId) hike.walkId = null; // Save walk makes a new one
        renderLibrary();
        // Otherwise it would stay on the map and look as if Delete had failed.
        if (loaded && hike.running) toast('Deleted from the library. Still loaded for your hike: Stop, then Unload track.', 5000);
        else if (loaded) await removeLoadedTrack({ confirmed: true });
    });
    row.append(label, load, edit, exp, del);

    // The links and history line.
    const sub = document.createElement('div');
    sub.className = 'lib-sub';
    const parts = [];
    if (entryKind(entry) === 'walk') {
        const s = entry.stats;
        if (entry.recordedAt) parts.push(formatDateTime(entry.recordedAt));
        if (s) parts.push(`moving ${formatDuration(s.movingMs)} · ↑ ${formatMetres(s.ascent)}`);
        const t = links.trackOf(entry);
        if (t) parts.push(`along “${t.name}”`);
        else if (entry.trackName) parts.push(`along “${entry.trackName}” (not in the library)`);
        else parts.push('free walk');
    } else {
        const walks = links.walksOf(entry);
        if (walks.length) parts.push(`${walks.length} walk${walks.length > 1 ? 's' : ''}: ${walks.map((w) => w.recordedAt ? formatDateTime(w.recordedAt) : w.name).join(', ')}`);
        const from = entry.fromWalk ? byId.get(entry.fromWalk) : null;
        if (entry.fromWalk) parts.push(from ? `made from “${from.name}”` : 'made from a walk (deleted)');
    }
    if (entry.versionReason && entry.versions?.length) parts.push(entry.versionReason);
    sub.append(parts.join(' · '));
    if (entry.versions?.length) {
        const restore = Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: 'Restore previous version' });
        restore.addEventListener('click', () => restoreEntry(entry));
        sub.append(' ', restore);
    }
    if (parts.length || entry.versions?.length) row.append(sub);
    return row;
}

async function restoreEntry(entry) {
    const prev = entry.versions[0];
    if (!confirm(`Restore the previous version of “${entry.name}” (${formatDistance(buildTrack(prev.points).total)}, saved ${formatDateTime(prev.savedAt)})? ` +
        `The current one (${formatDistance(buildTrack(entry.points).total)}) is dropped.`)) return;
    const wasLoaded = trackKeyOf({ name: entry.name, points: entry.points, total: buildTrack(entry.points).total }) === trackKey();
    const restored = restoreVersion(entry, Date.now());
    await saveLibraryEntry(restored);
    if (wasLoaded && !hike.running) await setTrack(restored.name, restored.points, { eleInfo: restored.eleInfo, waypoints: restored.waypoints });
    renderLibrary();
    toast(`Restored “${entry.name}” (${formatDistance(buildTrack(restored.points).total)}).`);
}

$('fill-ele-btn').addEventListener('click', () => {
    if (!track) return toast('No track loaded.');
    if (!track.eleInfo.missing) return toast('All points already have elevations.');
    fillTrackElevations();
});

$('clear-btn').addEventListener('click', () => removeLoadedTrack());
$('lib-unload-btn').addEventListener('click', () => removeLoadedTrack());

$('sample-btn').addEventListener('click', async () => {
    try {
        const response = await fetch('samples/sample-loop.gpx');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { name, points } = parseGpx(await response.text());
        if (!await keepRecording('Loading the sample track')) return;
        await setTrack(name, points);
        resetTrip();
        showTab('go');
    } catch (err) {
        console.error('Sample load failed:', err);
        toast('Could not load the sample track.');
    }
});

// A square loop (~200 m sides) starting where you stand, for a walk-around test.
// Elevations come from the DEM (when online). Temporary: not brought back on
// reopening unless a hike with it was in progress.
$('test-loop-btn').addEventListener('click', async () => {
    if (!('geolocation' in navigator)) return toast('This browser cannot access GPS.');
    if (!await keepRecording('Creating the test loop')) return;
    toast('Getting your position…', 10_000);
    navigator.geolocation.getCurrentPosition((pos) => {
        const points = squareLoop({ lat: pos.coords.latitude, lon: pos.coords.longitude }, 200);
        setTrack('Test loop', points, { temporary: true });
        resetTrip();
        showTab('go');
        toast('Test loop created: north, east, south, back to start.');
    }, onGeoError, { enableHighAccuracy: true, timeout: 20_000 });
});

// ---------- Tabs: Explore, Plan, Go, Track Library, Settings ----------

const TABS = ['explore', 'plan', 'go', 'library', 'settings'];
let currentTab = null;

// Each part of the screen lists in data-tabs the tabs it belongs to. The hike
// (GPS, recording, alerts) carries on whatever tab is shown.
// Resolves false if leaving Plan was cancelled (unsaved changes kept).
function showTab(tab) {
    if (!TABS.includes(tab)) tab = 'explore';
    if (tab === currentTab) return true;
    if (currentTab === 'plan' && (!planner.close() || !guideImport.close())) return false;
    currentTab = tab;
    document.body.dataset.tab = tab;
    for (const el of document.querySelectorAll('[data-tabs]')) {
        el.classList.toggle('tab-off', !el.dataset.tabs.split(' ').includes(tab));
    }
    for (const b of document.querySelectorAll('#tabbar button')) {
        b.setAttribute('aria-current', b.dataset.tab === tab ? 'page' : 'false');
    }
    $('layers-panel').hidden = true;
    if (track && settings.profileShows === 'walk') showProfile(); // My walk shows on Go only
    if (reviewing != null) closeGapReview();
    if (tab === 'library') renderLibrary();
    if (tab === 'settings') fillSettings();
    if (tab !== 'plan') {
        settings.tab = tab;
        saveSettings();
    }
    updateChrome();
    return true;
}

// The action bar shows only when the tab has actions (Plan: once the planner is open).
function updateChrome() {
    const actions = currentTab === 'explore' || currentTab === 'go' || (currentTab === 'plan' && planner.active);
    $('toolbar').hidden = !actions;
    $('edit-loaded-btn').disabled = !track;
    updateLayout();
}

for (const b of document.querySelectorAll('#tabbar button')) {
    b.addEventListener('click', () => showTab(b.dataset.tab));
}

// ---------- Explore: place search, locate me, layers ----------

// On Enter (or the Search button) only, never while typing: each search uses
// the shared daily quota of the relay's key.
let searching = false;
$('search-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = $('search-input').value.trim();
    if (!text || searching) return;
    $('search-input').blur(); // closes the iPhone keyboard
    // Coordinates are read here, with no search request: shown first, then a tap goes there.
    const point = parseCoordinates(text);
    if (point) return showCoordinateResult(point);
    searching = true;
    showSearchResults('Searching…', []);
    const r = await searchPlaces(text, view.getCenter()); // nearby places first
    searching = false;
    if (!r.ok) {
        if (r.detail) console.warn('Place search:', r.reason, r.detail);
        return showSearchResults(r.reason === 'limit'
            ? 'Search limit reached for now: try again in a minute (or tomorrow).'
            : 'Place search unavailable right now (offline?).', []);
    }
    showSearchResults(r.places.length ? '' : `Nothing found for “${text}”.`, r.places);
});

function showCoordinateResult(point) {
    const f = formatCoordinates(point);
    showSearchResults('Coordinates (read on the phone, no search):', []);
    const b = Object.assign(document.createElement('button'), { type: 'button', textContent: f.decimal });
    b.append(Object.assign(document.createElement('small'), { textContent: `${f.dms} · tap to go there` }));
    b.addEventListener('click', () => {
        $('search-results').hidden = true;
        view.showPlace(point);
        showPointMenu(point);
    });
    $('search-list').replaceChildren(b);
}

// ---------- A point's menu: coordinates, Copy, use as start/end of a new track ----------

// Start and end chosen on the map for Plan › Draw a new track.
const planEnds = { start: null, end: null };

function showPointMenu(point) {
    const f = formatCoordinates(point);
    const box = document.createElement('div');
    box.className = 'point-menu';
    box.append(
        Object.assign(document.createElement('b'), { textContent: f.decimal }),
        Object.assign(document.createElement('div'), { className: 'dms', textContent: f.dms }),
    );
    const row = Object.assign(document.createElement('div'), { className: 'row' });
    const button = (label, action) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: label });
        b.addEventListener('click', action);
        row.append(b);
    };
    button('Copy', async () => {
        try {
            await navigator.clipboard.writeText(f.decimal);
            toast(`Copied ${f.decimal}`);
        } catch {
            prompt('Copy the coordinates:', f.decimal);
        }
    });
    button('Start here', () => setPlanEnd('start', point));
    button('End here', () => setPlanEnd('end', point));
    box.append(row);
    view.showPointMenu(point, box);
}

function setPlanEnd(which, point) {
    planEnds[which] = point;
    view.showPointMenu(null);
    renderPlanEnds();
    const other = which === 'start' ? 'end' : 'start';
    toast(planEnds[other]
        ? 'Start and end set: Plan › Draw a new track routes between them.'
        : `${which === 'start' ? 'Start' : 'End'} set. Set the ${other} too (long-press the map, or type coordinates), then Plan › Draw a new track.`, 5000);
}

function renderPlanEnds() {
    const el = $('plan-ends');
    const { start, end } = planEnds;
    el.hidden = !start && !end;
    const f = (p) => (p ? formatCoordinates(p).decimal : '–');
    el.replaceChildren(`From ${f(start)} → to ${f(end)}. Draw a new track starts there. `,
        Object.assign(document.createElement('button'), { type: 'button', className: 'link-btn', textContent: 'Clear', onclick: () => {
            planEnds.start = planEnds.end = null;
            renderPlanEnds();
        } }));
}

// The new track from the chosen start and end: one trail segment between them
// (one routing request), or just the start.
function planFromEnds() {
    const { start, end } = planEnds;
    if (!start && !end) return null;
    const first = start ?? end;
    const vertices = start && end ? [start, end] : [first];
    const segments = vertices.length === 2 ? [routingAvailable() ? 'trail' : 'straight'] : [];
    planEnds.start = planEnds.end = null;
    renderPlanEnds();
    return { name: `Track ${formatDateTime(Date.now())}`, plan: { vertices, segments, routes: segments.map(() => null) } };
}

view.onLongPress((point) => {
    if (currentTab === 'plan' && planner.active) return;
    showPointMenu(point);
});

function showSearchResults(message, places) {
    $('search-results').hidden = false;
    setText($('search-message'), message);
    $('search-list').replaceChildren(...places.map((place) => {
        const b = Object.assign(document.createElement('button'), { type: 'button', textContent: place.label });
        if (place.kind) b.append(Object.assign(document.createElement('small'), { textContent: place.kind }));
        b.addEventListener('click', () => {
            $('search-results').hidden = true;
            view.showPlace(place);
        });
        return b;
    }));
    setText($('search-credit'), places.length ? GEOCODER_ATTRIBUTION : '');
}

// Emptying the field removes the list and the pin; tapping the map hides the list.
$('search-input').addEventListener('input', (e) => {
    if (e.target.value) return;
    $('search-results').hidden = true;
    view.clearPlace();
});
view.on('click', () => {
    $('search-results').hidden = true;
    $('layers-panel').hidden = true;
});
if (!searchAvailable()) $('search-input').placeholder = 'Place search is not set up';

// One position request (not the hike's GPS): fly there and show the dot.
$('locate-btn').addEventListener('click', () => {
    if (hike.running && view.centerOnPosition()) return;
    if (!('geolocation' in navigator)) return toast('This browser cannot access GPS.');
    toast('Finding your position…', 15_000);
    navigator.geolocation.getCurrentPosition((pos) => {
        const fix = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy };
        if (!hike.running) view.showPosition(fix);
        view.jumpTo(fix);
        toast(`You are here (±${formatMetres(fix.acc)}).`);
    }, (err) => {
        toast(err.code === err.PERMISSION_DENIED
            ? 'Location is blocked. On iPhone: Settings › Privacy & Security › Location Services › Safari Websites › "While Using the App".'
            : 'Could not get your position. Try again outside, away from buildings.', 8000);
    }, { enableHighAccuracy: true, maximumAge: 30_000, timeout: 15_000 });
});

$('layers-btn').addEventListener('click', () => {
    $('layers-panel').hidden = !$('layers-panel').hidden;
});

// ---------- Service worker and updates ----------

let swRegistration = null;

function checkForUpdate() {
    swRegistration?.update().catch(() => {});
}

if ('serviceWorker' in navigator) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then((registration) => { swRegistration = registration; })
        .catch((err) => console.error('Service worker registration failed:', err));

    // A new version took over. Don't reload by itself: that would stop GPS mid-hike.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (hadController) $('update-banner').hidden = false;
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
        if (event.data?.type === 'VERSION') setText($('info-version'), event.data.version);
    });
}

$('reload-btn').addEventListener('click', () => location.reload());

// ---------- Moved to trails.rinociardo.com (v0.15.1) ----------
// The old address (GitHub Pages) keeps working for a while, with a banner on every
// opening (× hides it until the next one) and a note in the Track Library. Data on
// the phone belongs to one address, so tracks and walks move by GPX export/import.
const NEW_HOME = 'https://trails.rinociardo.com/';
if (location.hostname === 'rinociardo.github.io' || new URLSearchParams(location.search).has('moved')) {
    $('moved-banner').hidden = false;
    $('moved-note').hidden = false;
    $('moved-close').addEventListener('click', () => { $('moved-banner').hidden = true; });
}
$('moved-banner').querySelector('a').href = NEW_HOME;


$('update-btn').addEventListener('click', async () => {
    if (!swRegistration) return toast('Offline support is not active in this browser.');
    try {
        await swRegistration.update();
        toast(swRegistration.installing || swRegistration.waiting
            ? 'Downloading the new version…'
            : 'You have the latest version.');
    } catch {
        toast('Could not check for updates (offline?).');
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
        if (hike.running) saveRecording();
        return;
    }
    // iOS drops the wake lock and pauses audio when the app goes to the background.
    if (hike.running && !wakeLock) requestWakeLock();
    audioCtx?.resume().catch(() => {});
    checkStaleFix();
    checkForUpdate();
    retryGaps();
});

// ---------- Start-up ----------

if (SIMULATE) toast('Simulated GPS is on: Go › Start replays the track. Turn it off in Settings › Testing.', 5000);
showTab(settings.tab === 'plan' ? 'explore' : settings.tab);
renderTrackStatus();
renderAlertToggle();
showProfile();
renderStats();
renderWalk();
renderDebug();
$('dem-credits').replaceChildren(...DEM_CREDITS.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
restoreAll();
