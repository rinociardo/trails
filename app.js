import { buildTrack, locateOnTrack, pointAtDistance, haversine } from './geo.js';
import { parseGpx, buildGpx, gpxFileName, NO_ELEVATION_DESC } from './gpx.js';
import { buildProfile, profileAt, DEFAULT_ELEVATION_THRESHOLD_M } from './elevation.js';
import { PositionSmoother, MotionTracker, PathRecorder, DEFAULT_TRACKING, trimToWindow, elevationRange } from './tracker.js';
import { createMapView } from './map-view.js';
import { createProfileChart } from './profile-chart.js';
import { TERRAIN, DEMO_TERRAIN } from './map-config.js';
import { fillElevationsFromDem, DEM_NAME, DEM_CREDITS } from './dem-tiles.js';
import { createPlanner } from './planner.js';

// Developer switches: ?sim (or ?sim=N for N× walking speed, default 10) replays
// the loaded track with GPS noise, a stop and a detour; ?terrain=demo previews
// 3D terrain with MapLibre's demo elevation tiles.
const params = new URLSearchParams(location.search);
const terrain = params.get('terrain') === 'demo' ? DEMO_TERRAIN : TERRAIN;

const DEFAULT_CENTER = { lat: 40.5, lon: 18.0 };
const OFF_TRACK_CONFIRM_FIXES = 2;  // consecutive far fixes before alerting (filters GPS jumps)
const BACK_ON_TRACK_RATIO = 0.8;    // must come back inside 80% of the limit to clear the alert
const ALERT_REPEAT_MS = 60_000;
const STALE_FIX_MS = 30_000;
const DEBUG_HISTORY = 60;           // fixes kept for the debug view
const WALKED_REDRAW_MS = 5000;      // the walked line is redrawn at most this often
const SETTINGS_KEY = 'trails.settings';
const DEFAULT_SETTINGS = {
    offTrackM: 50,
    offTrackStraightM: 100, // on straight (cross-country) segments of a planned track
    sound: true,
    autoDimS: 60,
    maxAccuracyM: DEFAULT_TRACKING.maxAccuracyM,
    smoothWindow: DEFAULT_TRACKING.windowSize,
    stopRadiusM: DEFAULT_TRACKING.stopRadiusM,
    stopTimeS: DEFAULT_TRACKING.stopTimeS,
    stopClimbM: DEFAULT_TRACKING.stopClimbM,
    eleThresholdM: DEFAULT_ELEVATION_THRESHOLD_M,
    steepSlopeDeg: 30,      // planner: warn when a straight segment crosses steeper terrain
    debug: false,
    simulate: false,
    panelOpen: true,
};

const $ = (id) => document.getElementById(id);

// ---------- Settings (small, so localStorage is fine) ----------

function loadSettings() {
    try {
        return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') };
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

function formatDistance(m) {
    if (m == null || !Number.isFinite(m)) return '–';
    if (m < 1000) return `${Math.round(m)} m`;
    return `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`;
}

function formatMetres(m) {
    return m == null || !Number.isFinite(m) ? '–' : `${Math.round(m)} m`;
}

// Local date and time, e.g. "2026-10-28 15:40".
function formatDateTime(time) {
    const d = new Date(time);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
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

// The map fills the space between the stats bar and the trip panel.
function updateLayout() {
    const root = document.documentElement.style;
    root.setProperty('--stats-h', `${$('stats').offsetHeight}px`);
    root.setProperty('--panel-h', `${$('trip-panel').offsetHeight}px`);
}
$('trip-panel').classList.toggle('collapsed', !settings.panelOpen);
$('trip-toggle').setAttribute('aria-expanded', String(settings.panelOpen));
updateLayout();
const layoutObserver = new ResizeObserver(updateLayout);
layoutObserver.observe($('stats'));
layoutObserver.observe($('trip-panel'));

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

const chart = createProfileChart($('profile'));

const planner = createPlanner({
    view,
    chart,
    settings,
    saveEntry: saveLibraryEntry,
    exportGpx,
    toast,
    formatDistance,
    formatMetres,
    formatDateTime,
    // Back to the loaded track's profile and numbers.
    onExit() {
        chart.setData(track, track?.profile ?? null);
        renderTrip();
    },
});

// ---------- State ----------

// { name, points, cum, total, profile, eleInfo, temporary }: profile is null without
// elevations; eleInfo counts where they came from (see elevationText); temporary
// marks the test loop, which is not brought back on reopening.
let track = null;

const smoother = new PositionSmoother({ maxAccuracyM: settings.maxAccuracyM, windowSize: settings.smoothWindow });
const motion = new MotionTracker({ stopRadiusM: settings.stopRadiusM, stopTimeS: settings.stopTimeS, stopClimbM: settings.stopClimbM });
const path = new PathRecorder(); // the hike as walked, for GPX export

const hike = {
    running: false,
    watchId: null,
    simTimer: null,
    clockTimer: null,
    lastFix: null,      // position shown on the map: { lat, lon, acc }
    lastFixAt: 0,
    prevAlong: 0,
    progress: null,     // { along, offset } from the snapped, smoothed position
    farCount: 0,
    offTrack: false,
    lastAlertAt: 0,
    dimmed: false,
    savedPoints: 0,     // path.pointCount when the walk was last exported or saved as a track
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

function renderStats() {
    const p = hike.progress;
    const done = track && p ? p.along : null;
    const remaining = track ? track.total - (p ? p.along : 0) : null;
    const offset = track && p ? p.offset : null;

    const doneText = done == null ? '–' : formatDistance(done);
    const remainingText = remaining == null ? '–' : formatDistance(remaining);
    const offsetText = formatDistance(offset);

    setText($('stat-done'), doneText);
    setText($('stat-remaining'), remainingText);
    setText($('stat-offset'), offsetText);
    setText($('dim-done'), doneText);
    setText($('dim-remaining'), remainingText);
    setText($('dim-offset'), offsetText);

    $('stat-offset').classList.toggle('alert', hike.offTrack);
    $('dim-overlay').classList.toggle('off-track', hike.offTrack);
    $('alert-banner').hidden = !hike.offTrack;
    if (hike.offTrack) setText($('alert-distance'), `${offsetText} from route`);

    renderTrip();
}

// Done / remaining / total table and the profile marker. Totals show as soon
// as a track is loaded, so trails can be compared before starting.
function renderTrip() {
    if (planner.active) return; // the planner shows its own totals and profile
    const prof = track?.profile;
    const along = hike.progress?.along ?? 0;
    const started = Boolean(track && hike.progress);
    const done = (v) => (started ? v : '–');

    setText($('t-dist-done'), done(formatDistance(along)));
    setText($('t-dist-rem'), track ? formatDistance(track.total - along) : '–');
    setText($('t-dist-total'), track ? formatDistance(track.total) : '–');

    const at = prof ? profileAt(track, prof, along) : null;
    setText($('t-asc-done'), prof ? done(formatMetres(at.ascentDone)) : '–');
    setText($('t-asc-rem'), prof ? formatMetres(prof.totalAscent - at.ascentDone) : '–');
    setText($('t-asc-total'), prof ? formatMetres(prof.totalAscent) : '–');
    setText($('t-desc-done'), prof ? done(formatMetres(at.descentDone)) : '–');
    setText($('t-desc-rem'), prof ? formatMetres(prof.totalDescent - at.descentDone) : '–');
    setText($('t-desc-total'), prof ? formatMetres(prof.totalDescent) : '–');
    setText($('dim-climb'), prof ? formatMetres(prof.totalAscent - at.ascentDone) : '–');

    let summary = 'No track · Start records your walk';
    if (track) {
        summary = prof
            ? `${formatDistance(track.total)} · ↑ ${formatMetres(prof.totalAscent)} · ↓ ${formatMetres(prof.totalDescent)}`
            : `${formatDistance(track.total)} · no elevation data`;
    }
    setText($('trip-summary'), summary);
    setText($('track-info'), track ? elevationText(track) : '');
    if (!hike.dimmed) chart.setPosition(started ? along : null);
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
    else if (e.missing) parts.push('DEM not reachable (offline?): Settings › Fill elevations retries');
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
    view.setWalked(path.snapshot());
}

// Distance actually walked and moving/stopped time (from the motion tracker).
function renderWalk(now = Date.now()) {
    motion.tick(now);
    const recorded = motion.movingMs + motion.stoppedMs > 0;
    const walked = recorded ? formatDistance(motion.walked) : '–';
    const moving = recorded ? formatDuration(motion.movingMs) : '–';
    // Average speed over moving time only; meaningless in the first minute.
    const hours = motion.movingMs / 3_600_000;
    const speed = motion.movingMs >= 60_000 ? `${(motion.walked / 1000 / hours).toFixed(1)} km/h` : '–';
    setText($('w-walked'), walked);
    setText($('w-moving'), moving);
    setText($('w-stopped'), recorded ? formatDuration(motion.stoppedMs) : '–');
    setText($('w-speed'), speed);
    // Free recording (no track): these replace Done/Remaining/From track.
    if (!track) {
        setText($('stat-walked'), walked);
        setText($('stat-moving'), moving);
        setText($('stat-speed'), speed);
        setText($('dim-walked'), walked);
        setText($('dim-moving'), moving);
        setText($('dim-speed'), speed);
    }

    $('save-walk-btn').hidden = hike.running || !walkUnsaved();

    const status = $('motion-status');
    status.hidden = !hike.running;
    const stopped = motion.state === 'STOPPED';
    const text = stopped ? `Stopped ${formatDuration(now - motion.stoppedSince)}` : 'Moving';
    setStatus(status, text, stopped ? 'warn' : '');
    setText($('dim-motion'), hike.running ? text : '');
}

// No track loaded = free recording: Start still records the walk, and the
// parts that compare against a track are hidden.
function renderTrackStatus() {
    document.body.classList.toggle('free-mode', !track);
    let text = hike.running ? 'Free recording (no track)' : 'No track — Open GPX, or Start to record';
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
    if (!track) return 'Climb    – (no track)';
    if (!track.profile) return 'Climb    – (track has no elevations)';
    const w = trimToWindow(debug.eles, now, settings.stopTimeS * 1000);
    if (w.length < 2) return `Climb    – (waiting for fixes)`;
    const range = elevationRange(w);
    const spanS = (w[w.length - 1].time - w[0].time) / 1000;
    const net = w[w.length - 1].ele - w[0].ele;
    const rate = spanS > 0 ? Math.round(Math.abs(net) / spanS * 3600) : 0;
    return `Climb    ${range.toFixed(1)} m in ${Math.round(spanS)} s (net ${net >= 0 ? '+' : '−'}${Math.abs(net).toFixed(1)} m, ` +
        `${rate} m/h); limit ${settings.stopClimbM} m` +
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
        raw ? `Raw      ±${Math.round(raw.acc)} m ${raw.accepted ? 'used' : 'DISCARDED'}` +
            (debug.lastInterval ? `, every ${(debug.lastInterval / 1000).toFixed(1)} s` : '') : 'Raw      –',
        `Discard  ${debug.discarded} fixes worse than ${settings.maxAccuracyM} m`,
        sm ? `Smooth   ${sm.count}/${settings.smoothWindow} fixes, ±${sm.acc.toFixed(1)} m` : 'Smooth   –',
        raw && sm ? `Raw→smooth ${haversine(raw, sm).toFixed(1)} m` : 'Raw→smooth –',
        stopped
            ? `Stop     inside ${Math.round(motion.radius)} m of stop centre`
            : `Stop chk spread ${motion.history.length > 1 ? Math.round(motion.spread()) : 0} m of ${Math.round(motion.radius)} m, ` +
              `need ${settings.stopTimeS} s`,
        climbLine(now),
        hike.progress ? `Snapped  ${formatDistance(hike.progress.along)}, ${formatMetres(hike.progress.offset)} off` : 'Snapped  –',
        `Walked   ${formatDistance(motion.walked)}`,
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
        savedAt: Date.now(),
    };
    kvSet('recording', record).catch((err) => console.error('Saving recording failed:', err));
}

function restoreRecording(saved) {
    if (!saved || saved.motion.movingMs + saved.motion.stoppedMs === 0) return;

    const apply = () => {
        motion.restore(saved.motion);
        path.restore(saved.path);
        hike.savedPoints = saved.savedPoints ?? 0;
        if (saved.trackKey && saved.trackKey === trackKey() && saved.progress) {
            hike.prevAlong = saved.prevAlong;
            hike.progress = saved.progress;
        }
        renderStats();
        renderWalk();
        renderDebug();
        renderWalkedPath(true);
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
        `stopped ${formatDuration(saved.motion.stoppedMs)}` +
        (sameTrack && saved.progress ? ` · ${formatDistance(saved.progress.along)} along ${track.name || 'the track'}` : '') +
        `. Saved ${ago < 60_000 ? 'less than a minute' : `${Math.round(ago / 60_000)} min`} ago; ` +
        'time while the app was closed is not counted.');
    $('resume-dialog').showModal();
    // Handled on the tap itself, so Start may use Wake Lock and sound.
    $('resume-yes').onclick = () => {
        $('resume-dialog').close();
        apply();
        startHike();
    };
    // Start fresh discards the recording; a free one that was never exported
    // or saved gets the same "keep it?" question as loading a track.
    $('resume-no').onclick = async () => {
        $('resume-dialog').close();
        apply();
        if (await keepRecording('Starting fresh')) {
            resetTrip();
            kvDelete('recording').catch(() => {});
        }
    };
}

// eleInfo: pass the saved one when restoring; otherwise elevations in the file
// count as "own" and missing ones are fetched from the DEM.
async function setTrack(name, points, { save = true, eleInfo = null, temporary = false } = {}) {
    const own = points.filter((p) => Number.isFinite(p.ele)).length;
    track = { name, ...buildTrack(points), temporary };
    track.eleInfo = eleInfo ? { ...eleInfo } : { own, dem: 0, missing: points.length - own, status: 'ok' };
    track.profile = buildProfile(track, settings.eleThresholdM);
    chart.setData(track, track.profile);
    hike.prevAlong = 0;
    hike.progress = null;
    resetOffTrack();
    view.setTrack(points);
    view.fitTrack(points);
    renderTrackStatus();
    renderStats();
    if (save) await saveTrack();
    if (track.eleInfo.missing) fillTrackElevations();
}

async function saveTrack() {
    const { name, points, eleInfo, temporary } = track;
    try {
        await kvSet('track', { name, points, eleInfo: { ...eleInfo, status: eleInfo.status === 'loading' ? 'failed' : eleInfo.status }, temporary });
        requestPersistence();
    } catch (err) {
        console.error('Saving track failed:', err);
        toast('Track shown, but it could not be saved on this device.');
    }
}

// Missing elevations from the DEM (needs the network). The track keeps them,
// so this happens once per track; Settings › Fill elevations retries.
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
        chart.setData(t, t.profile);
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
    chart.setData(null, null);
    view.clearTrack();
    renderTrackStatus();
    renderStats();
    try {
        await kvDelete('track');
    } catch (err) {
        console.error('Removing track failed:', err);
    }
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
        if (!savedTrack.temporary || (savedRecording?.running && savedRecording.trackKey === key)) {
            await setTrack(savedTrack.name, savedTrack.points,
                { save: false, eleInfo: savedTrack.eleInfo, temporary: savedTrack.temporary });
        } else {
            kvDelete('track').catch(() => {});
        }
    }
    restoreRecording(savedRecording);
    if (!track) {
        openOnMyPosition();
        toast('Open a GPX file, or press Start to record a walk.');
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
    const file = event.target.files[0];
    event.target.value = ''; // allow choosing the same file again
    if (!file) return;
    try {
        const { name, points } = parseGpx(await file.text());
        const trackName = name || file.name.replace(/\.gpx$/i, '');
        if (!await keepRecording(`Opening “${trackName}”`)) return;
        await setTrack(trackName, points);
        resetTrip();
        toast(`Loaded ${formatDistance(track.total)} track.`);
    } catch (err) {
        console.error('GPX import failed:', err);
        toast(err.message || 'Could not read this file.', 5000);
    }
});

// ---------- Off-track detection and alerts ----------

function resetOffTrack() {
    hike.farCount = 0;
    hike.offTrack = false;
}

function updateOffTrack(offset, limit) {
    if (offset > limit) {
        hike.farCount++;
    } else {
        hike.farCount = 0;
        if (hike.offTrack && offset < limit * BACK_ON_TRACK_RATIO) {
            hike.offTrack = false;
            toast('Back on track.');
        }
    }
    if (hike.farCount >= OFF_TRACK_CONFIRM_FIXES) {
        if (!hike.offTrack) {
            hike.offTrack = true;
            alertUser();
        } else if (Date.now() - hike.lastAlertAt > ALERT_REPEAT_MS) {
            alertUser();
        }
    }
}

function alertUser() {
    hike.lastAlertAt = Date.now();
    // Android only: iPhone Safari has no web vibration.
    navigator.vibrate?.([400, 200, 400]);
    if (settings.sound) beep();
}

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
        if (!$('settings').open) enterDim();
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

    const smoothed = smoother.add(raw);
    pushLimited(debug.raw, { ...raw, accepted: Boolean(smoothed) });
    if (!smoothed) {
        debug.discarded++;
        setStatus($('gps-status'), `GPS weak ±${Math.round(raw.acc)} m (ignored)`, 'warn');
        renderDebug();
        return;
    }
    pushLimited(debug.smooth, smoothed);
    setStatus($('gps-status'), `GPS ±${Math.round(raw.acc)} m`, 'ok');

    // Snap first (while moving): stop detection uses the track elevation here
    // to tell a slow steep climb from a stop.
    const loc = track && motion.state !== 'STOPPED' ? locateOnTrack(track, smoothed, hike.prevAlong) : null;
    const ele = loc && track.profile ? profileAt(track, track.profile, loc.along).ele : null;
    const anchor = motion.anchor; // update() clears it when walking resumes
    const change = motion.update(smoothed, raw.acc, now, ele);
    const stopped = motion.state === 'STOPPED';

    // Recorded path: elevations from the track only while near it.
    if (change === 'stopped') path.stop(motion.anchor, motion.stoppedSince);
    if (change === 'resumed') path.resume(anchor, now);
    if (!stopped) path.add({ ...smoothed, ele: loc && loc.offset <= settings.offTrackM ? ele : null, time: now });
    if (change) saveRecording();
    renderWalkedPath(Boolean(change));

    if (settings.debug && track?.profile) {
        // While stopped the track isn't snapped for progress; snap here for the debug figure only.
        const at = loc ?? locateOnTrack(track, smoothed, hike.prevAlong);
        debug.eles.push({ time: now, ele: loc ? ele : profileAt(track, track.profile, at.along).ele });
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

    // While dimmed the map is hidden: skip redrawing it to save battery.
    if (!hike.dimmed) view.showPosition(hike.lastFix, { offTrack: hike.offTrack });
    renderStats();
    renderWalk(now);
    renderDebug();
}

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
        if (along >= stopAt && stopLeft > 0) stopLeft--;
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
        onFix({
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
    path.startSegment();
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
    }, 1000);
    renderWalk();
    resetIdleTimer();
    saveRecording();
}

// Stop pauses the recording; Start continues it (Settings › Reset walked/time).
function stopHike() {
    if (hike.watchId != null) navigator.geolocation.clearWatch(hike.watchId);
    clearInterval(hike.simTimer);
    clearInterval(hike.clockTimer);
    clearTimeout(idleTimer);
    hike.watchId = hike.simTimer = hike.clockTimer = null;
    hike.running = false;
    hike.lastFixAt = 0;
    motion.pause(Date.now());
    smoother.reset();
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
    if (hike.running) stopHike();
    else startHike();
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

$('settings-btn').addEventListener('click', () => {
    $('set-offtrack').value = settings.offTrackM;
    $('set-offtrack-straight').value = settings.offTrackStraightM;
    $('set-steep').value = settings.steepSlopeDeg;
    $('set-sound').checked = settings.sound;
    $('set-autodim').value = String(settings.autoDimS);
    $('set-maxacc').value = settings.maxAccuracyM;
    $('set-window').value = settings.smoothWindow;
    $('set-stopradius').value = settings.stopRadiusM;
    $('set-stoptime').value = settings.stopTimeS;
    $('set-stopclimb').value = settings.stopClimbM;
    $('set-elethreshold').value = settings.eleThresholdM;
    $('set-debug').checked = settings.debug;
    $('set-simulate').checked = SIMULATE;
    $('set-simulate').disabled = params.has('sim');
    fillDeviceInfo();
    renderLibrary();
    $('settings').showModal();
});

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

const applyTracking = () => {
    smoother.configure({ maxAccuracyM: settings.maxAccuracyM, windowSize: settings.smoothWindow });
    motion.configure({ stopRadiusM: settings.stopRadiusM, stopTimeS: settings.stopTimeS, stopClimbM: settings.stopClimbM });
};
bindNumberSetting('set-maxacc', 'maxAccuracyM', applyTracking);
bindNumberSetting('set-window', 'smoothWindow', applyTracking);
bindNumberSetting('set-stopradius', 'stopRadiusM', applyTracking);
bindNumberSetting('set-stoptime', 'stopTimeS', applyTracking);
bindNumberSetting('set-stopclimb', 'stopClimbM', applyTracking);
bindNumberSetting('set-offtrack-straight', 'offTrackStraightM');
bindNumberSetting('set-steep', 'steepSlopeDeg', () => planner.refresh());
bindNumberSetting('set-elethreshold', 'eleThresholdM', () => {
    if (!track) return;
    track.profile = buildProfile(track, settings.eleThresholdM);
    chart.setData(track, track.profile);
    renderTrip();
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

$('reset-trip-btn').addEventListener('click', async () => {
    if (walkUnsaved()) {
        if (await keepRecording('Resetting walked/time')) resetTrip();
    } else if (confirm('Reset walked distance and moving/stopped time to zero?')) {
        resetTrip();
    }
});

$('set-offtrack').addEventListener('change', (e) => {
    const value = Math.round(Number(e.target.value));
    settings.offTrackM = Number.isFinite(value) ? Math.min(500, Math.max(10, value)) : DEFAULT_SETTINGS.offTrackM;
    e.target.value = settings.offTrackM;
    saveSettings();
});

$('set-sound').addEventListener('change', (e) => {
    settings.sound = e.target.checked;
    saveSettings();
    if (settings.sound) {
        unlockAudio();
        beep(); // lets you check the volume right away
    }
});

$('set-autodim').addEventListener('change', (e) => {
    settings.autoDimS = Number(e.target.value);
    saveSettings();
    resetIdleTimer();
});

$('settings').addEventListener('close', resetIdleTimer);

$('reverse-btn').addEventListener('click', () => {
    if (!track) return toast('No track loaded.');
    setTrack(track.name, track.points.slice().reverse(), { eleInfo: track.eleInfo, temporary: track.temporary });
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
    exportGpx(buildGpx({ name, segments: [track.points] }), gpxFileName(name), name);
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
    const desc = path.hasElevations ? '' : NO_ELEVATION_DESC;
    const pointCount = path.pointCount;
    const exported = await exportGpx(buildGpx({ name, desc, segments: path.snapshot(), time: start }),
        gpxFileName(track ? `${base} walked` : base, start), name);
    if (exported) markWalkSaved(pointCount);
    return exported;
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
        `Your walk (${formatDistance(motion.walked)}, moving ${formatDuration(motion.movingMs)}` +
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
            const saved = await saveWalkAsTrack();
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

// Adds an entry to Saved walks, or replaces the one with the same id (an edited track).
async function saveLibraryEntry(entry) {
    const entries = await loadLibrary();
    const i = entries.findIndex((e) => e.id === entry.id);
    if (i >= 0) entries[i] = entry;
    else entries.push(entry);
    await kvSet('library', entries);
    requestPersistence();
}

function openPlanner(entry = null) {
    if (hike.running) return toast('Stop the hike first.');
    $('settings').close();
    planner.open(entry);
}

$('new-track-btn').addEventListener('click', () => openPlanner());

// Saves the walk to Settings › Saved walks, with elevations: the planned
// track's where the walk followed it, the DEM's for the rest.
async function saveWalkAsTrack() {
    const points = walkedPoints();
    if (points.length < 2) {
        toast('Nothing recorded yet: press Start and walk a little.');
        return false;
    }
    const pointCount = path.pointCount;
    const name = track ? `${track.name} (walked ${formatDateTime(path.startTime)})` : `Walk ${formatDateTime(path.startTime)}`;
    const own = points.filter((p) => Number.isFinite(p.ele)).length;
    toast(`Saving “${name}”: getting elevations from the DEM…`, 20_000);
    let result = null;
    try {
        result = await fillElevationsFromDem(points);
    } catch (err) {
        console.error('DEM elevations failed:', err);
    }
    const dem = result?.filled ?? 0;
    const missing = points.length - own - dem;
    const entry = {
        id: `walk-${Date.now()}`,
        name,
        points: result?.points ?? points,
        eleInfo: { own, dem, missing, status: !missing ? 'ok' : result?.tooLarge ? 'tooLarge' : 'failed' },
        savedAt: Date.now(),
    };
    try {
        await saveLibraryEntry(entry);
    } catch (err) {
        console.error('Saving walk failed:', err);
        toast('Could not save the walk on this device.', 5000);
        return false;
    }
    markWalkSaved(pointCount);
    renderLibrary();
    toast(`Saved “${name}” in Settings › Saved walks. ` +
        (missing ? `${missing} points still need elevations (offline?): they are fetched when you load it.` : 'Elevations from the DEM.'), 7000);
    return true;
}

$('save-walk-btn').addEventListener('click', () => saveWalkAsTrack());
$('save-walk-settings-btn').addEventListener('click', () => saveWalkAsTrack());

async function renderLibrary() {
    const list = $('library');
    let entries = [];
    try {
        entries = await loadLibrary();
    } catch (err) {
        console.error('Loading saved walks failed:', err);
    }
    list.replaceChildren(...entries.slice().reverse().map((entry) => {
        const row = document.createElement('div');
        row.className = 'library-row';
        const label = document.createElement('span');
        label.textContent = `${entry.name} · ${formatDistance(buildTrack(entry.points).total)}`;
        const load = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Load' });
        load.addEventListener('click', async () => {
            if (!await keepRecording(`Loading “${entry.name}”`)) return;
            await setTrack(entry.name, entry.points, { eleInfo: entry.eleInfo });
            resetTrip();
            $('settings').close();
            toast(`Loaded ${formatDistance(track.total)} track.`);
        });
        const edit = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Edit' });
        edit.addEventListener('click', () => openPlanner(entry));
        const del = Object.assign(document.createElement('button'), { type: 'button', className: 'danger', textContent: 'Delete' });
        del.addEventListener('click', async () => {
            if (!confirm(`Delete “${entry.name}” from this device?`)) return;
            await kvSet('library', (await loadLibrary()).filter((e) => e.id !== entry.id));
            renderLibrary();
        });
        row.append(label, load, edit, del);
        return row;
    }));
    $('library-empty').hidden = entries.length > 0;
}

$('fill-ele-btn').addEventListener('click', () => {
    if (!track) return toast('No track loaded.');
    if (!track.eleInfo.missing) return toast('All points already have elevations.');
    fillTrackElevations();
    $('settings').close();
});

$('clear-btn').addEventListener('click', () => {
    if (!track) return toast('No track loaded.');
    if (confirm('Remove the current track from this device?')) clearTrack();
});

$('sample-btn').addEventListener('click', async () => {
    try {
        const response = await fetch('samples/sample-loop.gpx');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const { name, points } = parseGpx(await response.text());
        if (!await keepRecording('Loading the sample track')) return;
        await setTrack(name, points);
        resetTrip();
        $('settings').close();
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
        $('settings').close();
        toast('Test loop created: north, east, south, back to start.');
    }, onGeoError, { enableHighAccuracy: true, timeout: 20_000 });
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
});

// ---------- Start-up ----------

if (SIMULATE) toast('Simulated GPS is on: Start replays the track. Turn it off in Settings › Testing.', 5000);
renderTrackStatus();
renderStats();
renderWalk();
renderDebug();
$('dem-credits').replaceChildren(...DEM_CREDITS.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
restoreAll();
