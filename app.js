import { buildTrack, locateOnTrack, pointAtDistance } from './geo.js';
import { parseGpx } from './gpx.js';
import { createMapView } from './map-view.js';
import { TERRAIN, DEMO_TERRAIN } from './map-config.js';

// Developer switches: ?sim replays the loaded track with a fake detour,
// ?terrain=demo previews 3D terrain with MapLibre's demo elevation tiles.
const params = new URLSearchParams(location.search);
const SIMULATE = params.has('sim');
const terrain = params.get('terrain') === 'demo' ? DEMO_TERRAIN : TERRAIN;

const DEFAULT_CENTER = { lat: 40.5, lon: 18.0 };
const MAX_ACCURACY_M = 50;          // fixes worse than this don't move progress or trigger alerts
const OFF_TRACK_CONFIRM_FIXES = 2;  // consecutive far fixes before alerting (filters GPS jumps)
const BACK_ON_TRACK_RATIO = 0.8;    // must come back inside 80% of the limit to clear the alert
const ALERT_REPEAT_MS = 60_000;
const STALE_FIX_MS = 30_000;
const SETTINGS_KEY = 'trails.settings';
const DEFAULT_SETTINGS = { offTrackM: 50, sound: true, autoDimS: 60 };

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

// ---------- Track storage (IndexedDB: GPX tracks can be large) ----------

function idb(mode, action) {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('trails-app', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('kv');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            const tx = db.transaction('kv', mode);
            const request = action(tx.objectStore('kv'));
            tx.oncomplete = () => { db.close(); resolve(request.result); };
            tx.onerror = () => { db.close(); reject(tx.error); };
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

let toastTimer = null;
function toast(message, ms = 3000) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// The map fills the space between the stats bar and the toolbar.
function updateLayout() {
    document.documentElement.style.setProperty('--stats-h', `${$('stats').offsetHeight}px`);
}
updateLayout();
new ResizeObserver(updateLayout).observe($('stats'));

// ---------- Map ----------

// The demo elevation tiles only cover Innsbruck, so the preview opens there, tilted.
const startView = terrain === DEMO_TERRAIN
    ? { center: { lat: 47.27, lon: 11.39 }, zoom: 12, pitch: 60 }
    : { center: DEFAULT_CENTER, zoom: 11, pitch: 0 };
const view = createMapView({ container: 'map', ...startView, terrain });

view.on('webglcontextlost', () => {
    toast('The map display was reset by the phone. It should redraw by itself.', 6000);
});

// ---------- State ----------

let track = null; // { name, points, cum, total }

const hike = {
    running: false,
    watchId: null,
    simTimer: null,
    staleTimer: null,
    lastFix: null,
    lastFixAt: 0,
    prevAlong: 0,
    progress: null, // { along, offset }
    farCount: 0,
    offTrack: false,
    lastAlertAt: 0,
    dimmed: false,
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
}

function renderTrackStatus() {
    const text = track
        ? `${track.name || 'Track'} · ${formatDistance(track.total)}`
        : 'No track — tap Open GPX';
    setText($('track-status'), text);
}

// ---------- Track loading ----------

async function setTrack(name, points, { save = true } = {}) {
    track = { name, ...buildTrack(points) };
    hike.prevAlong = 0;
    hike.progress = null;
    resetOffTrack();
    view.setTrack(points);
    view.fitTrack(points);
    renderTrackStatus();
    renderStats();
    if (save) {
        try {
            await kvSet('track', { name, points });
            requestPersistence();
        } catch (err) {
            console.error('Saving track failed:', err);
            toast('Track shown, but it could not be saved on this device.');
        }
    }
}

async function clearTrack() {
    track = null;
    hike.progress = null;
    resetOffTrack();
    view.clearTrack();
    renderTrackStatus();
    renderStats();
    try {
        await kvDelete('track');
    } catch (err) {
        console.error('Removing track failed:', err);
    }
}

async function restoreTrack() {
    try {
        const saved = await kvGet('track');
        if (saved?.points?.length >= 2) {
            await setTrack(saved.name, saved.points, { save: false });
            return;
        }
    } catch (err) {
        console.error('Loading saved track failed:', err);
    }
    toast('Open a GPX file to begin.');
}

$('gpx-input').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    event.target.value = ''; // allow choosing the same file again
    if (!file) return;
    try {
        const { name, points } = parseGpx(await file.text());
        await setTrack(name || file.name.replace(/\.gpx$/i, ''), points);
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

function updateOffTrack(offset) {
    const limit = settings.offTrackM;
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
    // The map is not updated while dimmed; catch up now.
    if (hike.lastFix) view.showPosition(hike.lastFix, { offTrack: hike.offTrack });
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

function onFix(position) {
    const fix = {
        lat: position.coords.latitude,
        lon: position.coords.longitude,
        acc: position.coords.accuracy,
    };
    hike.lastFix = fix;
    hike.lastFixAt = Date.now();

    const good = fix.acc <= MAX_ACCURACY_M;
    setStatus($('gps-status'),
        good ? `GPS ±${Math.round(fix.acc)} m` : `GPS weak ±${Math.round(fix.acc)} m`,
        good ? 'ok' : 'warn');

    if (good && track) {
        const loc = locateOnTrack(track, fix, hike.prevAlong);
        hike.prevAlong = loc.along;
        hike.progress = { along: loc.along, offset: loc.offset };
        updateOffTrack(loc.offset);
    }

    // While dimmed the map is hidden: skip redrawing it to save battery.
    if (!hike.dimmed) view.showPosition(fix, { offTrack: hike.offTrack });
    renderStats();
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

// Replays the loaded track in about four minutes, with one detour of up to
// 120 m to the side around 30–38% of the way, to exercise the off-track alert.
function startSimulation() {
    const speed = Math.max(5, track.total / 240);
    const detourStart = track.total * 0.30;
    const detourEnd = track.total * 0.38;
    let along = 0;
    hike.simTimer = setInterval(() => {
        along = Math.min(track.total, along + speed);
        const p = pointAtDistance(track, along);
        let side = 0;
        if (along > detourStart && along < detourEnd) {
            const f = (along - detourStart) / (detourEnd - detourStart);
            side = 120 * (1 - Math.abs(2 * f - 1));
        }
        // Shift sideways, perpendicular to the current segment.
        const a = track.points[p.index], b = track.points[p.index + 1];
        const cosLat = Math.cos(p.lat * Math.PI / 180);
        const dx = (b.lon - a.lon) * cosLat, dy = b.lat - a.lat;
        const len = Math.hypot(dx, dy) || 1;
        const lat = p.lat + (dx / len) * side / 111320;
        const lon = p.lon - (dy / len) * side / (111320 * cosLat);
        onFix({ coords: { latitude: lat, longitude: lon, accuracy: 6 } });
        if (along >= track.total) {
            clearInterval(hike.simTimer);
            hike.simTimer = null;
            toast('Simulation finished.');
        }
    }, 1000);
}

function startHike() {
    if (SIMULATE && !track) {
        toast('Load a track first, then press Start to simulate.');
        return;
    }
    if (!SIMULATE && !('geolocation' in navigator)) {
        toast('This browser cannot access GPS.');
        return;
    }
    unlockAudio();
    hike.running = true;
    view.setFollow(true);
    $('start-btn').textContent = 'Stop';
    $('start-btn').classList.add('running');
    setStatus($('gps-status'), SIMULATE ? 'Simulating GPS' : 'Waiting for GPS…', 'warn');
    requestWakeLock();
    if (SIMULATE) {
        startSimulation();
    } else {
        hike.watchId = navigator.geolocation.watchPosition(onFix, onGeoError, {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 30_000,
        });
    }
    hike.staleTimer = setInterval(checkStaleFix, 5000);
    resetIdleTimer();
}

function stopHike() {
    if (hike.watchId != null) navigator.geolocation.clearWatch(hike.watchId);
    clearInterval(hike.simTimer);
    clearInterval(hike.staleTimer);
    clearTimeout(idleTimer);
    hike.watchId = hike.simTimer = hike.staleTimer = null;
    hike.running = false;
    hike.lastFixAt = 0;
    releaseWakeLock();
    exitDim();
    resetOffTrack();
    $('start-btn').textContent = 'Start';
    $('start-btn').classList.remove('running');
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
    $('set-sound').checked = settings.sound;
    $('set-autodim').value = String(settings.autoDimS);
    fillDeviceInfo();
    $('settings').showModal();
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
    setTrack(track.name, track.points.slice().reverse());
    toast('Track direction reversed.');
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
        await setTrack(name, points);
        $('settings').close();
    } catch (err) {
        console.error('Sample load failed:', err);
        toast('Could not load the sample track.');
    }
});

// A square loop (~200 m sides) starting where you stand, for a walk-around test.
$('test-loop-btn').addEventListener('click', () => {
    if (!('geolocation' in navigator)) return toast('This browser cannot access GPS.');
    toast('Getting your position…', 10_000);
    navigator.geolocation.getCurrentPosition((pos) => {
        const { latitude: lat, longitude: lon } = pos.coords;
        const dLat = 200 / 111320;
        const dLon = 200 / (111320 * Math.cos(lat * Math.PI / 180));
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
        setTrack('Test loop', points);
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
    if (document.visibilityState !== 'visible') return;
    // iOS drops the wake lock and pauses audio when the app goes to the background.
    if (hike.running && !wakeLock) requestWakeLock();
    audioCtx?.resume().catch(() => {});
    checkStaleFix();
    checkForUpdate();
});

// ---------- Start-up ----------

if (SIMULATE) toast('Simulation mode: Start replays the track with a detour.', 5000);
renderTrackStatus();
renderStats();
restoreTrack();
