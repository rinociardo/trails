# Trails: project requirements

Keep this file up to date: whenever the user adds, changes or drops a requirement,
edit the relevant section here in the same session (and record the date of
decisions). It is the single source of truth for what the app must do.

## Goal: four-stage hiking workflow

1. **Scout**: browse a map to find an area to look for trails.
2. **Plan**: create a track (route) for the hike on that map.
3. **Prepare**: save the map tiles for that area offline, at the highest zoom/resolution
   available, so the map works with no cell signal.
4. **Hike**: start the track and monitor live GPS position along it: where I am on the
   route, distance done/remaining, and whether I'm off-track.

Reference app for look and feel: **Maps 3D PRO** (iPhone). 3D terrain and hill shading are
wanted eventually.

## Target device

- **iPhone 13, iOS, Safari, app added to the Home Screen** (standalone PWA). Every feature
  must work there first. Android/desktop are a bonus.
- iPhone limits to design around: no web vibration (`navigator.vibrate` doesn't exist);
  GPS stops when the screen locks or the app is backgrounded; Wake Lock in Home Screen apps
  was reportedly unreliable before iOS 18.4; storage can be evicted unless the app is on the
  Home Screen and `navigator.storage.persist()` is granted.

## Technical decisions

- **Clean rewrite** of the original prototype (decided 2026-10-27). The original code is kept
  in `legacy/` for reference only and must not be changed or deleted.
- **Map library: MapLibre GL JS** (decided 2026-10-27, replacing Leaflet). Currently 6.11.2,
  served locally from `vendor/maplibre-gl/` (no CDN at runtime). Use library versions at
  least two weeks old.
- **3D-ready structure**: only `map-view.js` touches MapLibre and only `map-config.js` names
  tile/elevation providers. Adding a terrain (elevation) source, hill shading and tilt must
  not require changes to the hiking logic.
- **Basemap for now: OpenStreetMap standard tiles, online only**, with correct attribution
  (© OpenStreetMap contributors, linked to openstreetmap.org/copyright, always visible).
  OSM's tile policy forbids bulk/offline downloading, so these tiles must **never** be
  cached for offline use. **The offline map source is still to be decided** (Stage 3).
- No build step: plain HTML/JS/CSS served as-is; ES modules.
- **Hosting: GitHub Pages**, repo `rinociardo/trails`, URL https://rinociardo.github.io/trails/.
  HTTPS is required for GPS, the service worker and installing. The `rinociardo.github.io`
  origin is shared with the user's other projects: prefix cache/storage names (`trails-`).

## Requirements by area

### Foundation (done in v0.2.0)
- Web manifest, icons, Apple Home Screen tags (apple-touch-icon, status bar, title).
- App must launch offline from the Home Screen (service worker caches the app shell).
- Update strategy that never gets stuck: versioned cache (bump `VERSION` in `sw.js` on every
  release), network-first with offline fallback, old caches removed, "new version" banner
  instead of an automatic reload (reloading mid-hike would stop GPS).

### Hike prototype (done in v0.2.0, awaiting iPhone testing)
- Import a GPX file and show it on the map; keep it saved on the device.
- Show live position; distance done and remaining along the track.
- Off-track alert when more than a user-set distance from the track: on-screen banner plus
  sound (vibration where the platform allows it).
- Keep the screen awake with the Wake Lock API, showing whether it is active.
- Battery-friendly behaviour wherever possible (GPS only while hiking, black "dim" screen
  for the OLED display, auto-dim, minimal map redraws).

### Elevation profile, like Maps 3D PRO (done in v0.3.0, awaiting iPhone testing)
- Chart of the loaded track: distance (km) on x, elevation (m) on y, marker at my current
  position (`profile-chart.js`; drag a finger on it to read any point).
- Live numbers: distance, ascent and descent, each done / remaining (`elevation.js`).
- Totals (distance, ascent, descent) shown as soon as a track is loaded, before starting,
  so trails can be compared while scouting.
- Use the **track's** elevation at my snapped position, never GPS altitude (too noisy).
- Smooth elevations before summing ascent/descent. Chosen: **5 m hysteresis** (a climb or
  drop only counts once it exceeds 5 m), adjustable in Settings to compare with Maps 3D PRO.
- GPX without elevations shows "no elevation data". Later: fill from a DEM (Digital
  Elevation Model) source.

### Position smoothing (done in v0.3.0)
- Discard fixes whose reported accuracy is worse than **30 m**.
- Average the last **~5 good fixes**, weighted by accuracy (weight 1/accuracy²), before
  snapping to the track. Fixes older than 30 s are dropped from the average.
- Window size and accuracy threshold are settings. Lag: about (N−1)/2 fixes, so ≈2 s
  (≈3 m at walking pace) with 5 fixes at iPhone's ~1 fix/s.

### Standing detection (done in v0.3.0)
- STOPPED when all positions of the last **30 s** lie within **max(15 m, current accuracy)**
  of each other: walked distance freezes, "Stopped" shows with a timer.
  Decision: measured point-to-point (not as a radius from the centre), otherwise a 1 m/s
  walk counts as stopped. Consequence: below ≈1.8 km/h horizontal could count as stopped,
  hence the climb check below.
- **Slow steep climbs are not stops** (decided 2026-10-27, v0.3.1): no STOPPED if the track
  elevation at the snapped position changed by more than **3 m** (setting) within the
  window. 3 m per 30 s = 360 m/h of climbing; slower climbs can still register as stopped
  (lower the setting). Needs a track with elevations; snapping now happens before stop
  detection for this reason. Unit-tested: 1.2 km/h on a 40% slope stays MOVING; standing
  still on that slope is still a stop.
- MOVING again when I leave that distance from the stop's centre; counting continues from
  there. Decision: the real distance (approach to the stop centre, and centre to the exit
  point) is kept, so stops don't lose up to ~30 m each.
- Show moving time and stopped time; average speed uses moving time only.
- Two separate distances: progress along the planned track (from snapping) and distance
  actually walked (recorded, with stop detection).
- No off-track alarms from jitter while stopped (position and progress are frozen).
- Radius, time and climb are settings. Stop/Start pauses and resumes the recording; "Reset
  walked/time" in Settings starts it again (also reset when a new track is loaded).

### Recording persistence (done in v0.3.1)
- The walked/time recording (plus progress along the track) is saved to IndexedDB every
  **10 s** while hiking, on every MOVING/STOPPED change, on Start/Stop/reset, and when the
  app goes to the background.
- On reopening: if the hike was running, a **"Resume hike?"** prompt (Resume / Start
  fresh); if it had been stopped, the numbers are restored quietly. Progress is only
  restored onto the same track. Time while the app was closed is not counted; at most
  the last 10 s can be lost.
- Test plan step: start a simulated hike, force-close from the app switcher, reopen,
  check it resumes (README, step 5).

### Debug view (done in v0.3.0)
- Toggle in Settings › Testing. Map shows raw fixes (orange), discarded fixes (red rings),
  smoothed positions (blue) and the stop circle (purple, dashed); a text box shows the
  state, accuracies, fixes used/discarded, raw-to-smoothed distance, stop check, snapped
  progress and walked distance.
- **Climb line** (v0.4.0, requested 2026-10-28): the box also shows the track-elevation
  change (max − min, plus net change and m/h) over the current stop-time window, both while
  moving and while stopped, so the "unless the track climbed more than" setting can be chosen
  from real walks (slow climb vs standing on a slope). While stopped the position is snapped
  for this figure only. Standing still is not 0: jitter moves the snapped point along a slope
  (≈1 m in the simulation).
- `?sim` simulation includes GPS noise, bad fixes, a 45 s stop and a detour
  (`?sim=N` sets N× walking speed, default 10). Also switchable in Settings › Testing ›
  Simulated GPS, because the Home Screen app always opens the plain address.

### GPX export (done in v0.4.0, requested 2026-10-28)
- Purpose: move tracks between devices without a server (plan on the Mac, hike with the
  iPhone).
- **Export track**: the loaded/planned track as GPX 1.1, keeping elevations (Settings ›
  Export (GPX)).
- **Export my hike**: the path actually walked, with a timestamp on every point. One
  `<trkseg>` per Start..Stop. A point is kept every 5 m (≈2000 points for 10 km). Stops
  mirror the walked-distance logic: the jitter is replaced by the stop centre, written at
  the stop's start and end times (the time gap is the stop). Elevation per point = the
  planned track's elevation at the snapped position, only while within the off-track
  limit (never GPS altitude); otherwise no `<ele>`. The path is saved with the recording
  (survives a force-close) and cleared by "Reset walked/time" or loading a new track.
- Delivery: **Web Share API with the file** where `navigator.canShare({files})` allows it
  (iPhone and Mac Safari: Share sheet with Save to Files, AirDrop, Messages); otherwise a
  normal download. Cancelling the sheet does nothing; any other share error falls back to
  a download.
- File names: `Trackname_YYYY-MM-DD.gpx` (local date; hike: `Trackname-walked_<hike date>`).
  Letters of any language are kept; other characters become `-`.
- Test: export on the Mac, AirDrop to the iPhone, import; totals and profile must match
  (README step 10). Verified in a headless browser: re-imported track gives identical
  totals.
- `.gitignore` still blocks all personal `*.gpx` files.
- Not yet: showing the walked path as a line on the map (only the position dot and, in the
  debug view, recent fixes are drawn).

### Free recording (done in v0.5.0, requested 2026-10-28)
- **Start works with no track loaded**: records the walk with smoothing, stop detection,
  walked distance, moving/stopped time, average speed and the debug view.
- Nothing to compare against, so progress/remaining/off-track parts are **hidden, not shown
  as zeros**: the top bar shows Walked / Moving / Avg speed instead of Done / Remaining /
  From track (also on the dim screen); the trip panel hides the done/remaining table and the
  profile. No off-track alerts. The debug box says "Climb – (no track)".
- Survives a force-close like a normal hike (same recording save and "Resume hike?").
- **Export my hike** works: file `Free-recording_<date>.gpx`. No elevations (GPS altitude
  stays unused); the file says so in `<desc>` ("No elevation data…") in `<metadata>` and
  `<trk>`. The same note is written for any recorded hike with no elevation at all. Later:
  fill from a DEM.
- Loading a track resets the recording (as before), so export a free walk first.
- Simulated GPS with no track walks a 2 km square (10 points per side) from the last
  recorded point, or the map centre, so free recording can be tested without walking.
- "Test loop here" creates a track **without elevations** (label says so): the Climb line,
  ascent/descent and profile stay empty with it.

### Still to build
- Stage 3 Prepare: offline map download for an area at the highest zoom available
  (needs the offline map source decision; must respect provider terms and storage limits).
- Stage 2 Plan: create a route on the map (GPX export of it already works via Export track).
- Stage 1 Scout: improvements (search, locate me, topographic layer, trail overlay).
- 3D terrain and hill shading (hook exists in `map-config.js`: `TERRAIN`).

## How to work with this user

- The user validates by **testing, not by reading code**. For every change or finding,
  say how they can check it themselves (on the iPhone where possible), and keep the
  iPhone test plan in `README.md` current.
- Expand acronyms the first time they appear; organise reports with headings.
- When asked to review or report only, **do not modify, rename or delete files**.
- **Never push or publish without the user's explicit OK.** Show the exact commands first.
- The repo is public: commits use the user's **GitHub noreply address** (set as this repo's
  `user.email`, decided 2026-10-27). Never put a personal email address in commits or files.
- **Personal GPX tracks must never be committed** (`.gitignore` blocks `*.gpx`); the only
  track in the repo is `samples/sample-loop.gpx`.

## Developer notes

- Run locally: `python3 -m http.server 8000`; tests: `npm test`.
- Developer switches: `?sim` / `?sim=N` (replays the loaded track with noise, a stop and a
  120 m detour) and `?terrain=demo` (3D terrain preview over Innsbruck).
- Pure logic lives in `geo.js`, `elevation.js`, `tracker.js` and the writer in `gpx.js`, unit-tested in `tests/`;
  keep it free of browser APIs so it stays testable with Node.
- Known gap: GPS does not run while the app is closed or in the background (iOS limit), so
  distance walked in that time is missing from the recording.
