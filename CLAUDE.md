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
- **DEM (Digital Elevation Model): Terrain Tiles** (proposed by Claude and **confirmed by
  the user 2026-10-28**), open data on AWS (registry.opendata.aws/terrain-tiles), terrarium PNG
  tiles to z15, `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`.
  Free to use, caching allowed; attribution required (Mapzen plus the national data
  sources: list in `map-config.js` `DEM.credits`, shown in Settings › Data sources). Open to
  any website (CORS `*`); the EU copy of the bucket refuses public access, so the US one is
  used. Elevations are read at **z14** (≈7 m pixels at 45° N; the data behind most of
  Europe is the 30 m EU-DEM). The same tiles are meant for 3D terrain/hill shading later.
  Checked: Lake Garda 61 m (surface ≈65), Monte Cimone 2127 m (2165), Mont Blanc 4780 m
  (4808): summits come out a little low on a 30 m grid.
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
- GPX without elevations: missing elevations are filled from the DEM (see "Elevations from
  the DEM"); "no elevation data" only shows while that hasn't worked (offline).

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
- Loading a track resets the recording, but the walk is **protected** first (see "Keeping
  recordings").
- Simulated GPS with no track walks a 2 km square (10 points per side) from the last
  recorded point, or the map centre, so free recording can be tested without walking.
- "Test loop here" used to have no elevations; since v0.6.0 it gets them from the DEM (when
  online), so the label no longer says "no elevations".

### Walked path on the map (done in v0.6.0, requested 2026-10-28)
- The recorded path is drawn as a **pink line** (`#d6336c`, white casing) over the map, in
  free mode and also with a track (planned track stays blue). One line per Start..Stop.
- Battery: redrawn at most every **5 s**, at once on moving/stopped changes, Stop, reset and
  restore; not while dimmed (caught up when the dim screen is tapped).

### Keeping recordings (done in v0.6.0, requested 2026-10-28)
- Any recording (at least 2 points; **free or with a track**: decided 2026-10-28, v0.6.1)
  that hasn't been **exported** or **saved as a track** is protected: Open GPX, Load sample,
  Test loop, loading a saved walk, "Start fresh" in the Resume prompt and Settings › Reset
  walked/time first ask **"Keep your walk?" Export / Save as track / Discard / Cancel**
  (Reset keeps its plain confirmation once the walk is saved). Export goes ahead only if
  the file was really shared or downloaded (closing the Share sheet keeps the question
  open). Points recorded after an export/save make it unsaved again. Reverse direction and
  Remove track don't clear the recording, so they don't ask.
- **Save as track** (panel button after a recording, and Settings › Export): stores the
  walked path (segments joined, doubled stop points removed) in **Settings › Saved walks**
  (IndexedDB key `library`), named `Walk YYYY-MM-DD HH:MM` (with a track: `Track (walked …)`).
  Elevations: the planned track's where the walk followed it, the DEM for the rest. Saved
  walks can be loaded (and followed) or deleted. Saving does not load it, so "Export my
  hike" still works on the recording afterwards.

### Elevations from the DEM (done in v0.6.0, requested 2026-10-28)
- Any track with points lacking elevation (GPX without `<ele>`, saved walks, the test loop)
  gets them from the DEM when loaded, **only for the missing points** (elevations in the
  file are kept). Bilinear interpolation, one download per tile (6 at a time), at most 150
  tiles per track (otherwise nothing is fetched: "track too spread out"). Results are saved
  with the track, so it happens once.
- Offline: the track loads without them; retried automatically when the phone goes online,
  or with Settings › Track › **Fill elevations**.
- **Track info** line in the panel: `Elevation: 812 of 812 points · 812 from the DEM (Terrain
  Tiles)` (or "all N points from the file", or how many are still missing and why).
- GPS altitude is still never used. Exported hikes stay as recorded (no DEM elevations in
  "Export my hike"); "Export track" of a DEM-filled track includes them.

### Reopening the app (done in v0.6.0, requested 2026-10-28)
- Settings › Remove track already existed (since v0.2.0).
- The **test loop is temporary**: not restored on reopening unless a hike with it was
  running (it is then restored and the Resume prompt shows).
- With no track: the map opens where the last recording ended, else on the **current
  position** (one location request, cached up to 5 min, no dot drawn until Start).

### Stage 2 Plan, step 1: simple planner (done in v0.7.0, requested 2026-10-28)
- Mainly for the Mac (mouse), also iPhone/iPad (touch). Settings › Saved walks › **New
  track** opens the planner; **Edit** on a saved entry edits it. Not available while a hike
  is running.
- Tap/click the map to add a point at the end, joined by a straight line. Drag a point to
  move it; tap it to delete it (an inner point's two segments become one). Each segment has a
  small middle handle: drag it to insert a point. **Undo** button (also Cmd/Ctrl+Z on the
  Mac; up to 200 steps, a drag is one step). Double-tap zoom is off while planning.
  Hit area around points: 10 px with a mouse, 22 px with a finger.
- Live totals in the panel header (distance, ↑, ↓, number of points) and the elevation
  profile, from the **DEM**: the line is sampled every **25 m** (plus every point) and the
  elevations fetched (tiles cached in memory, 48 at most), 250 ms after the last change.
- Name field in the planner's top bar (default `Track YYYY-MM-DD HH:MM`). **Save** stores it
  in Saved walks (edit = replace the same entry). **Export** writes a GPX 1.1 of the sampled
  line with elevations (the segment types are not in the GPX). **Done** leaves (asks if
  unsaved).
- Saved entry: `points` (the sampled line with `ele` and `straight` per point, what a hike
  follows) plus `plan: { vertices, segments }` (what the planner edits).
- Editing a **recorded walk** simplifies it (Douglas-Peucker, 3 m) into draggable points on
  "trail" segments (they followed real paths) and saves a **new** entry `Name (edited)`, so
  the recording is kept.

### Cross-country (straight) segments (requested 2026-10-28)
- Every segment is either **"trail"** (follow trails) or **"straight"** (a straight line);
  stored per segment. Straight segments are drawn **dashed**, trail segments solid.
- Step 1 (done in v0.7.0): no routing, so every segment drawn in the planner is straight;
  switching a segment's type comes with step 2. Edited recorded walks are "trail".
- Step 2 (with routing, to build): switch a segment either way; if the router finds no path,
  or its path is **more than 3×** the straight distance, fall back to a straight segment and
  say so.
- **Steep-slope warning** (done in v0.7.0): straight segments are checked against the
  terrain slope from the DEM (central differences, 15 m each way, at every 25 m sample). Above
  the setting (Settings › Planning, default **30°**) the segment turns orange and the top bar
  says e.g. "⚠ Straight segment 1 crosses slopes up to 48°". It is terrain slope, not the
  line's own gradient: a line along a steep hillside also warns. Checked at Lauterbrunnen:
  a line across the valley warns (48°), none at a 60° limit.
- **Hike tolerance** (done in v0.7.0): on straight segments the off-track limit is Settings ›
  Alerts › "…on straight (cross-country) segments", default **100 m** (normal limit 50 m).
  Tested by simulation: 91 m from a straight line with limits 50/200 m raised no alert.

### Stage 2 Plan, step 2: snap to trails (proposal, waiting for the user's choice)
Proposal of 2026-10-28 (all four allow calls from a browser, CORS checked):
- **openrouteservice** (HeiGIT): free key, 2,000 routes/day, 40/min; `foot-hiking` profile.
  access=private/no paths excluded unless foot is allowed. Key would be visible in a public
  page, so let the user enter their own key in Settings. Recommended.
- **BRouter** (brouter.de): free, no key, best hiking profiles (`hiking-mountain` with SAC
  limit), returns elevation. No published terms or limits for the public server (a
  community service; ask before app use, or self-host). access=private/no: near-prohibitive
  penalty, but only a small one if the way is part of a marked hiking route.
- **GraphHopper**: free plan 500 credits/day, non-commercial, 5 points per request; blocks
  access=private by default; `hike` profile allows some ways `foot` avoids.
- **Valhalla on FOSSGIS servers**: free, no key, max 1 request/s, no guarantee, and FOSSGIS
  asks apps not to hard-code the address: fine for trying, not as the app's backend.
  Pedestrian handling of access=private not documented (to verify).
Routing would be per "trail" segment (between its two points), so editing costs one request
per changed segment.

### Still to build
- Stage 3 Prepare: offline map download for an area at the highest zoom available
  (needs the offline map source decision; must respect provider terms and storage limits).
- Stage 2 Plan, step 2: snap to trails (routing service to choose, see above).
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
- Pure logic lives in `geo.js`, `elevation.js`, `tracker.js`, `dem.js`, `plan.js` and the writer in `gpx.js`, unit-tested in `tests/`;
  keep it free of browser APIs so it stays testable with Node. `dem-tiles.js` is the browser
  side of the DEM (fetch + decode PNG tiles); `planner.js` is the planner screen.
- Known gap: GPS does not run while the app is closed or in the background (iOS limit), so
  distance walked in that time is missing from the recording.
