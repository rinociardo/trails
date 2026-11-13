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
- **Trail routing: openrouteservice, `foot-hiking` profile** (chosen by the user 2026-10-28).
  Only `router.js` talks to it (its address, limits and credit are `ROUTER` in
  `map-config.js`), so another service can replace it there. **a key must never be in the
  repo**. Free key: 2,000 routes a day, 40 a minute. Attribution "Routes © openrouteservice.org
  by HeiGIT · map data © OpenStreetMap contributors" is always shown in the planner bar and in
  Settings › Data sources.
- **Routing relay holding the owner's key** (decided by the user 2026-10-28, v0.9.0,
  replacing the per-user key field of v0.8.0): nobody needs any setup. `relay/worker.js` is
  a Cloudflare Worker (free plan) that keeps the user's openrouteservice key as a secret
  (`ORS_KEY`, set with `wrangler secret put`, never in a file) and forwards one
  `foot-hiking` route between two points. It accepts only `POST /route` with two points
  ≤ ≈50 km apart (optional `"alternatives": true`: up to 3 routes, since v0.13.0, for
  recording gaps; deployed by the user 2026-11-12) and (since v0.10.0, 2026-10-29) `POST /geocode` (place search: text
  ≤ 200 characters, 8 results, optional focus point); **nothing else of openrouteservice
  is reachable through it**. Only from `ALLOWED_ORIGINS` (trails.rinociardo.com since v0.15.1, rinociardo.github.io while people move, localhost:8000), at most
  30 requests a minute per IP (Cloudflare Rate Limiting binding, approximate, per
  location). Key problems map to quota → 429, refused key → 502. **Every error has a body**
  (requested 2026-10-29): the relay's own refusals say why (`{"error": "…", "from":
  "relay"}`); openrouteservice's message is always passed on (`{"error": {code, message},
  "from": "openrouteservice"}`). **The key is never logged or returned** (replaced by `[key]`
  if an answer quotes it); errors log only safe facts about it (length, stray spaces, unusual
  characters) for `wrangler tail`. Spaces around the stored key are ignored. First deploy
  (2026-10-29, https://trails-relay.rinociardo.workers.dev) answered 400 with an empty body
  from upstream. Cause (found 2026-10-29 with `wrangler tail`): the stored secret was a
  single control character, not the key (Ctrl+V in a Linux terminal types a control
  character; paste with Ctrl+Shift+V).
  openrouteservice's FAQ explicitly recommends this (a key belongs to one person and must
  not be used client-side; route requests through your own server).
  **Terms checked 2026-11-12** (account.heigit.org/info/tos and /info/plans, FAQ): server-side use
  with the key kept secret is the FAQ's first recommended practice; "every HeiGIT API key belongs to
  one person" and one account per person. The Standard plan is described as "free to use for everyone"
  (wording seen for HeiGIT's other services; the openrouteservice wording wasn't readable); the
  Collaborative plan is for humanitarian, academic, governmental or non-profit use. The terms don't
  forbid a server serving other people's apps, don't mention friends or sharing results, and say
  nothing about caching. Required: attribution (OpenStreetMap; results are CC-BY-SA 4.0); no
  transmitting personal data; repeated limit overruns can get the account blocked or removed.
  Open question for the user: whether serving a small group of friends fits "belongs to one person"
  (ask HeiGIT support to be sure). Known limit: the
  origin check stops other websites, not scripts faking the header; worst case the day's
  2,000 routes run out. The user deploys it themselves (`relay/README.md`; Wrangler pinned
  to 4.151.0), and redeploys it after any change to `relay/`. The relay address is `RELAY`
  in `map-config.js` (set since the first deploy; if it were empty, segments would be
  straight with the note "Trail routing isn't set up yet"). Any key saved by v0.8.0 is
  deleted from settings.
  **No personal-key screen for now.**
- **Place search: openrouteservice geocoding (Pelias) through the relay** (requested by the
  user 2026-10-29). Only `geocoder.js` talks to it (`GEOCODER` in `map-config.js`; the relay
  address is `RELAY` there). **Search on Enter only, no as-you-type suggestions**, to save
  quota. Free (Standard) plan, read from account.heigit.org on 2026-11-12: place search
  **1,000 a day, 100 a minute** (directions 2,000 a day, 40 a minute); the dashboard shows the
  key's own numbers.
  Attribution shown under the results and in Settings › Data sources. To be reused for
  From → To.
- No build step: plain HTML/JS/CSS served as-is; ES modules.
- **Hosting: Cloudflare Pages at https://trails.rinociardo.com/** (decided by the user 2026-11-13, v0.15.1; first planned as trail.rinociardo.com, changed the same day to **trails** with an s,
  before inviting testers), connected to the `rinociardo/trails` repo: every push to `main` publishes, no
  build step (output = repository root). rinociardo.com is registered at Porkbun with its DNS on Cloudflare
  (found 2026-11-13: a wildcard sent every host to rinociardo-com.l.ink), so the custom domain's CNAME is
  made in Cloudflare. Set-up steps: README › Publish. Until then: **GitHub Pages**, repo `rinociardo/trails`,
  https://rinociardo.github.io/trails/, which **keeps working for a while** with a "moved" banner (see
  "Moving to trails.rinociardo.com"). All app paths are relative (`./`), so the app runs at the root or in a
  folder unchanged. HTTPS is required for GPS, the service worker and installing. Storage names stay
  prefixed (`trails-`): the `rinociardo.github.io` origin is shared with the user's other projects.

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
- Off-track alert when more than a user-set distance from the track: on-screen banner,
  sound only if chosen (vibration where the platform allows it, with sound). Since v0.12.0
  a setting (see "Following a track").
- Keep the screen awake with the Wake Lock API, showing whether it is active.
- Battery-friendly behaviour wherever possible (GPS only while hiking, black "dim" screen
  for the OLED display, auto-dim, minimal map redraws).

### Elevation profile, like Maps 3D PRO (done in v0.3.0, awaiting iPhone testing)
- Chart of the loaded track: distance (km) on x, elevation (m) on y, marker at my current
  position (`profile-chart.js`; drag a finger on it to read any point).
- Live numbers: distance, ascent and descent, each done / remaining (`elevation.js`).
- Totals (distance, ascent, descent) shown as soon as a track is loaded, before starting,
  so trails can be compared while scouting.
- Elevation labels get the room they need (fixed 2026-10-29, v0.9.0: at a fixed 34 px
  margin "1300 m" showed as "300 m").
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
  restored onto the same track. Since v0.13.0 Resume turns the time the app was closed into
  a recording gap (see "Recording gaps"); until then it was not counted. At most the last
  10 s before the close can be lost.
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
  DEM elevation at the smoothed position (since v0.12.0; never GPS altitude); no `<ele>`
  for points recorded while the DEM couldn't be reached. Until v0.11.0 it was the planned
  track's elevation while near it. The path is saved with the recording
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
  as zeros**: the top bar shows Walked / Moving / Speed (Avg speed until v0.11.0) instead of
  Done / Remaining / From track (also on the dim screen, plus Ascent); the trip panel hides the
  done/remaining table and shows the walk's own profile (v0.12.0). No off-track alerts. The
  debug box's climb line uses the DEM ("Climb (DEM)").
- Survives a force-close like a normal hike (same recording save and "Resume hike?").
- **Export my hike** works: file `Free-recording_<date>.gpx`. Since v0.12.0 with DEM
  elevations and the ascent/descent in `<desc>`. A hike with no elevation at all (recorded
  with no signal anywhere) still says so in `<desc>` ("No elevation data…").
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
- Since v0.15.0 the walk is saved by itself on every Stop (see "Walk finished") and the buttons
  say **Save walk**; the walk goes to Track Library › Walks.
- **Save as track** (panel button after a recording, and Settings › Export): stores the
  walked path (segments joined, doubled stop points removed) in **Settings › Saved walks**
  (IndexedDB key `library`), named `Walk YYYY-MM-DD HH:MM` (with a track: `Track (walked …)`).
  Elevations: those recorded from the DEM (v0.12.0), the DEM fills any missing ones. Saved
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
- GPS altitude is still never used. "Export my hike" has the DEM elevations recorded during
  the walk (v0.12.0); "Export track" of a DEM-filled track includes them.

### Reopening the app (done in v0.6.0, requested 2026-10-28)
- Settings › Remove track already existed (since v0.2.0).
- The **test loop is temporary**: not restored on reopening unless a hike with it was
  running with some time recorded (it is then restored and the Resume prompt shows). A
  saved "Test loop" with no temporary flag (from before v0.6.0) counts as temporary
  (v0.10.1).
- **Removing the test loop** (v0.10.1, requested 2026-11-06 after the iPhone test): Track
  Library › Loaded track shows it as "temporary test track" with a **Remove test loop**
  button (ordinary tracks: **Unload track**, as in Go). Removing it stops and clears its test
  hike too (after "Keep your walk?" if unsaved: Export / Save as track / Discard / Cancel), so
  the app opens clean. "Start fresh" in the Resume prompt does the same. Unloading an ordinary
  track still leaves the recording alone.
- **Delete in the Track Library also unloads that track if it is the loaded one** (v0.10.1;
  the row says "loaded"), otherwise it stays on the map and Delete looks broken. During a
  hike it stays loaded, with a note.
- With no track: the map opens where the last recording ended, else on the **current
  position** (one location request, cached up to 5 min, no dot drawn until Start).

### Stage 2 Plan, step 1: simple planner (done in v0.7.0, requested 2026-10-28)
- Mainly for the Mac (mouse), also iPhone/iPad (touch). Settings › Saved walks › **New
  track** opens the planner; **Edit** on a saved entry edits it. Not available while a hike
  is running.
- Tap/click the map to add a point at the end, joined by a segment of the type shown on the
  **Next: Trail / Next: Straight** button (starts on Trail when the relay is set up, otherwise
  Straight). Drag a point to move it; tap it to delete it (an inner point's two segments
  become one). Each segment has a small handle in the middle of its line: drag it to insert a
  point, **tap it to switch the segment between trail and straight**. **Undo** button (also Cmd/Ctrl+Z on the
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
  follows) plus `plan: { vertices, segments, routes }` (what the planner edits).
- Editing a **recorded walk** simplifies it (Douglas-Peucker, 3 m) into draggable points on
  "trail" segments (they followed real paths) and saves a **new** entry `Name (edited)`, so
  the recording is kept.

### Cross-country (straight) segments (requested 2026-10-28)
- Every segment is either **"trail"** (follow trails) or **"straight"** (a straight line);
  stored per segment. Straight segments are drawn **dashed**, trail segments solid.
- Step 1 (v0.7.0): no routing, every planned segment was straight. Edited recorded walks
  are "trail" segments that keep the walked path as their line (no routing needed).
- Step 2 (done in v0.8.0): see "Stage 2 Plan, step 2" below.
- **Steep-slope warning** (done in v0.7.0; default and % changed 2026-10-28, v0.8.0): straight
  segments are checked against the terrain slope from the DEM (central differences, 15 m each
  way, at every 25 m sample). Above the setting (Settings › Planning, default **20° = 36%**;
  installs that still had the old default 30° move to 20°) the segment turns orange and the
  message says e.g. "⚠ Straight segment 1 crosses slopes up to 34° (68%); the warning starts
  at 20° (36%)". Slopes are always shown in **degrees and %** (grade = tan × 100). It is terrain slope, not the
  line's own gradient: a line along a steep hillside also warns. Checked at Lauterbrunnen:
  a line across the valley warns (48°), none at a 60° limit.
- **Hike tolerance** (done in v0.7.0): on straight segments the off-track limit is Settings ›
  Alerts › "…on straight (cross-country) segments", default **100 m** (normal limit 50 m).
  Tested by simulation: 91 m from a straight line with limits 50/200 m raised no alert.

### Stage 2 Plan, step 2: snap to trails (done in v0.8.0, requested 2026-10-28)
- Each "trail" segment is routed between its two points with openrouteservice `foot-hiking`
  (one request per segment, one at a time; answers remembered in memory, 200 at most, so
  undo/redo and reopening cost nothing). The route is joined to the two points (the router
  starts on the nearest path). Saved plans keep `routes` per segment, so reopening a saved
  track makes no requests. Moving a point re-routes its two segments; inserting re-routes
  both halves.
- A segment being routed is drawn faint. Trail segments are solid, straight ones dashed.
- **Fallback to straight, with a message** (never breaks planning): no route found (also: no
  path within 350 m of a point); route **more than 3×** the straight distance ("the trail
  would be 4.2× the straight distance (5.1 km instead of 1.2 km)"); limit reached (429:
  "Routing limit reached: drawn straight."); relay not set up, unreachable or any other
  error ("Trail routing unavailable right now: drawn straight."). In the last two cases every
  segment waiting for a route goes straight. Since v0.9.0 these are **short notes only, no
  toast** (requested 2026-10-28). Tapping a
  segment's middle handle twice (straight → trail) tries again; failures are not remembered.
- Messages, the steep warning and "Finding trails…" show in a dark box floating over the top
  of the map, which taps pass through: changing them must not resize the map (that shifted
  everything under the finger). Toasts also let taps through (v0.8.0).
- Tested in a headless browser with openrouteservice answers faked for each case (route,
  detour 21.7×, no route, 429, refused key): all fall back as above; a saved and reopened
  plan made no new requests. v0.9.0 re-tested headless with a faked relay (route, limit,
  unreachable, not configured); the relay itself is unit-tested (`tests/relay.test.js`) and
  its config checked with `wrangler deploy --dry-run`. Tested with the real relay on 2026-10-29
  (headless, from localhost:8000, Wengen): segments follow the paths, no errors.

Routing services compared on 2026-10-28 (all four allow calls from a browser, CORS checked):
- **openrouteservice** (HeiGIT): free key, 2,000 routes/day, 40/min; `foot-hiking` profile.
  access=private/no paths excluded unless foot is allowed. Key would be visible in a public
  page, so the user enters their own key in Settings. Recommended and **chosen**.
- **BRouter** (brouter.de): free, no key, best hiking profiles (`hiking-mountain` with SAC
  limit), returns elevation; best alternative. No published terms or limits for the public server (a
  community service; ask before app use, or self-host). access=private/no: near-prohibitive
  penalty, but only a small one if the way is part of a marked hiking route.
- **GraphHopper**: free plan 500 credits/day, non-commercial, 5 points per request; blocks
  access=private by default; `hike` profile allows some ways `foot` avoids.
- **Valhalla on FOSSGIS servers**: free, no key, max 1 request/s, no guarantee, and FOSSGIS
  asks apps not to hard-code the address: fine for trying, not as the app's backend.
  Pedestrian handling of access=private not documented (to verify).
Routing would be per "trail" segment (between its two points), so editing costs one request
per changed segment.

### Navigation: bottom tab bar (built in v0.10.0, requested 2026-10-29)
Status: **approved in principle; final approval after the user tests it on the iPhone and
the Mac.** Replaces the mixed Settings dialog. Tabs (left to right), each part of the screen
lists in `data-tabs` where it shows:
- **Explore**: place search (top bar), **Locate me** (one position request, blue dot, map
  jumps there), **Layers** (only OpenStreetMap standard for now; topographic, trail overlay,
  coverage planned), trip panel with the loaded track's totals/profile. Trail scan: to do
  (see below).
- **Plan**: a start card: **Draw a new track**, **Edit the loaded track** (like a recorded
  walk: simplified, saved as a new track), **Import a trail guide** (v0.11.0), From → To and Loop
  generator (greyed, "planned").
  Then the planner as before (name bar, Undo / Next / Save / Export / Done, totals/profile).
  Not while hiking. Leaving the tab with unsaved changes asks first (Cancel stays).
- **Go**: the hike screen: Start/Stop, Center, Dim, top numbers, trip table, profile,
  walked row, alerts; under the profile **Reverse direction · Fill elevations · Unload
  track** (unload keeps library copies). Track loaded = follow it; none = free walk.
- **Track Library** (renamed from "Library" by the user 2026-10-29): saved tracks and walks
  (Load → Go, Edit → Plan, Delete), **Import GPX** (also adds the file to the library),
  New track, **Loaded track** (Export track, Add to library), **Current recording** (Export
  my hike, Save as track, Reset walked/time).
- **Settings**: preferences only: Units, Alerts, Screen and battery (auto-dim, Wake Lock
  support), GPS smoothing, Stop detection, Elevation, Planning (steep slope), Data sources,
  Testing (debug view, simulated GPS, test loop, sample track), This device (version,
  check for update).
- The hike keeps running on every tab (red dot on Go); the off-track banner and toasts
  show above every tab. The last tab is reopened (Plan reopens as Explore).
- Nothing previously reachable was dropped (mapping in README step 21).

### Units (built in v0.10.0, requested 2026-10-29)
- Settings › Units: **km and m** or **miles and feet**; first default from the phone's
  region (US, Liberia, Myanmar → imperial). Applied everywhere: top bar, trip table, profile
  axes and finger readout, planner totals and messages, toasts, Resume/Keep dialogs, Track
  Library, debug box, GPS accuracy, and the Settings length fields (typed in m or ft, stored
  in metres; steps 10 ft / 5 m etc.). Speeds km/h or mph. Distances under 1,000 ft (1 km)
  are shown in ft (m).
- Exports: GPX coordinates and `<ele>` stay in **metres** (the GPX 1.1 standard; every app
  converts on import); the file's `<desc>` gives the totals in the chosen units ("Distance
  4.54 mi, ascent 739 ft, descent 731 ft"; a hike: walked distance and moving time).
- Slopes stay in degrees and %.

### Trail-guide importer (built in v0.11.0, requested 2026-11-06; awaiting iPhone testing)
Plan › **Import a trail guide** (`guide.js` pure logic, `guide-import.js` screen). For a club's
milestone sheet: one line per milestone, "mileage  description", `*` after the mileage = restrooms.
- **Input**: pasted text, or a file. Lines not starting with a mileage are ignored (listed,
  collapsed). The longest run of mileages that never goes down is kept, so a stray "30 hikers…"
  can't throw out the real lines. **A line with a phone number or email is never a milestone**, and
  only place names go to the search, never the sheet.
- **CSV**: columns `mile, place, note, restroom` (a header names them, any order; no header = that
  order). A place is searched as written; no place = a waypoint.
- **Places**: names are found in each line: addresses, then spots (Trailhead, Marina, Park…) in the
  line's first sentence. Not route points by default: direction words; names after to / past /
  until / **under** ("go under the bridge": the search finds the road on top, often across the
  canal); long things (Trail, Canal, Street) and road codes; the same place twice in a row.
- **Matching** (decided 2026-11-06 after real results): a result counts only if it **has the name
  searched for** and is **possible for the sheet's distance** from the place before (≤ sheet × 1.25 +
  1.5 km). If not, the name is retried with each state the sheet mentions (at most 1 + states
  searches per row; answers cached while the app is open). Otherwise no pin: "No match near the
  route", and rows below aren't affected. Correcting a row rechecks the ones below it (no searches).
- **Confirm / Change / Skip** per row, with numbered pins on the map. Change: search other text,
  pick from the results, or **tap the map**; dragging a pin also places it. Unnamed turns can be
  made places. Only confirmed places are routed.
- **Route**: `foot-hiking` between confirmed places, one leg at a time. A place is moved to where the
  route meets the trails, so an address off the path adds no spur. No detour limit here (unlike the
  planner): a long detour is shown and flagged. No route or relay down: straight leg, with a note.
- **Leg comparison**: table of sheet vs route per leg and in total; **more than 10% off is flagged**
  (red in the table, orange on the map). Not saved with the track.
- **Waypoints**: every milestone. A place is at its route point. A turn is placed by mileage **scaled
  to its leg**, so a leg routed 3% long doesn't shift its turns past the next place. Stored by
  lat/lon; distance along is worked out on load, so it holds after Reverse, GPX import and edits.
  Restrooms have an icon; tap a marker for its note. Editing the route in the planner keeps
  waypoints where they were (they aren't re-placed, and legs aren't re-compared).
- **Hike**: Go shows "In 0.82 mi" and the next waypoint's note (2 lines, tap for all), also on the
  dim screen. A waypoint within 15 m counts as reached.
- **GPX**: `<wpt>` before the track: name, `<desc>` the note, `<cmt>Sheet mile N</cmt>`, `<sym>`
  Restroom/Waypoint. Import reads them back. The Track Library keeps `waypoints` per entry.
- **Tested** 2026-11-06 with a real club sheet, through the real relay and router: about 4% over its
  total, every leg within 10%, once wrong-bank pins were gone. Some of its places were not in the search
  data, so they stayed waypoints or were placed by hand. The sheet and its results stay out of the repo.
- **Test sheet and recordings** (decided 2026-11-06): **nothing from a real guide goes in the repo**, not
  its wording, places or mileages; `.gitignore` blocks `*.docx`. `tests/fixtures/guide-milestones.txt` is
  an invented sheet. `tests/fixtures/guide-recorded-responses.json` holds invented answers in the
  real format, because a recording of real searches would bring real names back.
- **Tests use recorded answers by default, never the live relay** (decided 2026-11-06, confirmed
  2026-11-12): `npm test` loads `tests/helpers/no-network.js` first, so `fetch` fails in every test
  unless the test stubs it (`relay.test.js`) or uses `tests/helpers/recorded.js`; browser test scripts
  use its `useRecordedResponsesInBrowser(context)`. **The real relay only on the user's explicit request.**
- **Search quota**: a sheet takes 10–25 searches, answers are cached while the app is open
  (`cachedSearch`). Testing against the real service used about 130 in one evening, then openrouteservice
  answered 429 "Quota exceeded", still refused 2.5 minutes later (so not a per-minute limit; routing kept
  working). That is well under the published 1,000 a day, so the cause is unknown: check the key's
  dashboard.

### Following a track and free walk numbers (built in v0.12.0, requested 2026-11-12; awaiting iPhone testing)
- **Off-track alerts**: Settings › Alerts › Off-track alert **Off / Banner only / Banner + sound**,
  default **Banner only** (no sound unless chosen). Installs that had "Sound with off-track alert"
  (on by default) start at Banner only. Vibration (Android only) goes with sound.
- **Quick toggle on Go** (status line, only with a track): "Alerts: …" cycles off → banner only →
  banner + sound for the **current hike only** (saved with the recording, so Resume keeps it;
  cleared when the recording is reset or another track loaded). Settings keeps its own value.
- **Off track is always worked out**, whatever the alert: same limits and hysteresis as the banner
  (2 far fixes in a row; back inside 80% of the limit; the wider limit on straight segments),
  `OffTrackDetector` in `walk.js`. While off: Remaining (top bar, table distance/ascent/descent,
  dim screen) shows **"—"**, the third top number is labelled "Off track", and the panel says
  **"Off track: N m/ft to the track"**. Remaining comes back when back on track. Done keeps
  following the snapped position. The "Back on track" toast only when alerts aren't Off.
- **Free walk is the primary mode** and its numbers show with or without a track (panel "My walk"
  grid): distance walked, moving time, stopped time, current speed (last 15 s), average moving
  speed, elevation, ascent, descent, vertical speed now, average up, average down. Free mode top
  bar: Walked / Moving / Speed (current).
- **Elevation from the DEM at the smoothed position** (never GPS altitude), read on every fix from
  the tile in memory (`elevationAt` in `dem-tiles.js`: "…" while its tile loads). Ascent/descent use
  the existing hysteresis (5 m, Settings › Elevation), `ClimbCounter`, the same algorithm as a
  track's profile (unit-tested to match). Nothing is added while stopped; after Stop/Start or
  reopening, the next elevation starts afresh (the gap isn't a climb). The stop check's climb test
  now also works with no track (DEM elevation; the track's when it has elevations).
- **Vertical speed**: now = least-squares slope of the DEM elevation over the last minute (needs
  20 s), "level" under 60 m/h. Average up = ascent ÷ time spent climbing (moving with the trend
  above 60 m/h), average down likewise; shown after a minute of either. Units: **per hour**
  (default), per minute or per second, in m or ft (Settings › Units › Vertical speed).
- **Profile of the walk so far** (walked path against its DEM elevations, redrawn with the pink
  line every 5 s, not while dimmed). With no track it is the profile (Go only); with a track, a
  Track / My walk switch on Go (remembered); Explore always shows the track.
- **Stored DEM tiles**: every downloaded tile is kept in Cache Storage `trails-dem-tiles` (kept
  across app versions by `sw.js`), at most 600 (≈60 MB, oldest dropped first); the 8 tiles around
  the current one are stored too while walking. So a repeat walk, or a walk where a track was
  loaded with signal, works offline. Otherwise "unavailable" and a note on Go; failed tiles are
  retried after 20 s or when the phone goes online. Settings › Elevation shows how many are stored
  and can clear them. Terrain Tiles allow caching (see DEM above); OSM map tiles are still never
  stored.
- **Save as track and Export my hike** use these elevations (DEM only, not mixed with the track's:
  mixing put steps in the walk's profile). Exported `<desc>` gives ascent and descent.
- Recording save includes ascent, descent and the up/down times (`walk`), and the hike's alert
  choice (`alertOverride`).
- Tested 2026-11-12: unit tests (`tests/walk.test.js`); headless browser with synthetic DEM tiles
  (a 10% slope) and recorded relay answers: free walk numbers, export with elevations, offline in a
  stored area (works) and an unstored one ("unavailable"), off-track display with all three alert
  modes, Track / My walk switch, recording save.

### Recording gaps (built in v0.13.0, requested 2026-11-12; awaiting iPhone testing)
- **What happened before v0.13.0** (reported to the user 2026-11-12): in the background or
  locked, the clocks counted the whole gap in the state before it (usually moving), and the
  first fix after it added the **straight-line** distance to Walked, drawn as a straight jump in
  the pink line and the GPX. Closed and resumed: neither the time nor the distance counted, and
  Resume started a new segment. Elevation: the net change counted as one climb or drop.
- **A gap** = no accepted fix for **20 s** or more while a hike runs (background, screen locked,
  closed then Resume, or no GPS / only bad fixes). A deliberate Stop..Start is not a gap (new
  segment, nothing counted, as before). The clock ignores any jump over 10 s between its 1 s
  ticks (the app was suspended); at the first fix after a gap the clocks go back to the last fix
  before it and the gap accounts for the whole time (`MotionTracker.gap`).
- **Filling** (`gaps.js` rules, `gap-fill.js` in the background, like the planner):
  - Stopped before and still inside the stop area: all stopped time, nothing drawn.
  - Under **50 m**: straight line, no request.
  - **Track loaded** and on it before and after (same limits as off-track, straight segments
    wider): the track between the two points, no request, if walkable in the time.
  - Otherwise **one router request** (`foot-hiking`, `"alternatives": true` through the relay:
    up to 3 routes, sharing ≤ 60%, ≤ 1.6× the best). Routes are joined to both ends. Dropped:
    implied speed over the setting (Settings › Recording gaps, default **7 km/h**; × the
    simulation speed when simulating) or longer than **3×** the straight line. Default = implied
    speed closest to the **pace before the gap** (average moving speed, 4.3 km/h in the first
    minute). The straight line is always kept as a last option.
  - No route, or none walkable: straight line, **a guess** (with the reason). More than ≈50 km
    (the relay's limit): straight, a guess.
  - No signal or limit reached: straight line **"to be filled"**, retried when the phone goes
    online, when the app comes back, every minute while hiking and on reopening.
- **Counting**: the chosen option's length is walked. Gap time is moving for as long as that
  distance takes at the pace before the gap, the rest stopped. Ascent/descent from the option's
  DEM elevations (same hysteresis). Totals = recorded + gaps (`walkTotals`); the live climb
  counter pauses across a gap. Average up/down rates use recorded time only.
- **Resume after a force-close** carries on the same segment; the closed time becomes a gap from
  the last recorded point to the first fix.
- **No questions during the hike**: a short toast when it is filled, e.g. "Paused 8 min, filled
  from trails (640 m)", "…filled along the track", "…: no signal: filled when back online;
  straight for now", "…: no trail found, drawn straight (a guess)". Not for gaps under a minute
  and 50 m.
- **Track Library › Gaps in the recording**: one row per gap (time, length, how filled, other
  options), **Show** (after Stop) opens the map with that gap's options: grey dashed, the chosen
  one pink; tap a grey line or a button to switch; Previous / Next / Done. Totals follow.
- **Drawing**: filled gaps dashed in the pink walked line.
- **GPX**: each filled gap is its own `<trkseg>` (from the last fix before to the first after);
  its points carry `<type>Gap filled with a trail route (a guess)</type>` (or the planned track, a
  straight line…) and the filled ones `<fix>none</fix>`; `<desc>` says how many gaps were filled.
  Times of filled points are spread by distance between the gap's two fixes.
- Saved with the recording (`gaps`: ends, options with points and elevations, chosen, status).
- Settings › Testing › **Simulate a 1-minute GPS gap** (Simulated GPS on, hike running).
- Tested 2026-11-12: unit tests (`tests/gaps.test.js`); headless browser with a faked router
  (3 routes, one too long), synthetic DEM, never the live relay: free-walk gap filled from trails
  with the 3× route dropped, offline gap filled after "online", review switch updates totals,
  GPX gap segments, track gap with no request, Resume after a 40 s close counted as a gap.

### Smart Pause (built in v0.14.0, requested 2026-11-12; awaiting iPhone testing)
- **Pause** button on Go next to Start/Stop (Stop still ends or interrupts the hike). Pressing it draws a
  **pause zone** (amber circle) around the current position, radius Settings › Pause, default **150 m**
  (30–1000 m). The button becomes **Resume**.
- **While paused** positions still come in but **nothing counts**: no distance, moving or stopped time,
  climb, vertical speed or off-track alerts, even walking about inside the zone. Status line "Paused m:ss";
  the panel's **Paused** time is kept apart from Moving and Stopped and left out of every average.
- **Auto-resume** (`PauseWatcher` in `pause.js`): outside the zone for about **a minute**, at walking pace
  (0.5 m/s up to the gap-filling speed, 7 km/h by default) and going **steadily away** (at least half the
  distance walked since leaving leads away), or forward along the loaded track while on it (a loop that
  bends back past the zone). Counting is **backdated to the zone exit**: the positions since then are
  replayed as normal fixes. Banner (no sound) "Resumed: you're back on the move." with **Undo** (offered
  2 minutes).
- **Undo** (walking back to the car): back to paused, numbers, path and gaps as they were; that pause then
  never resumes by itself, and a manual Resume counts **from the moment it is pressed**.
- **Unclear** (outside but slow, back and forth, or faster than walking): banner "Still paused. Resume?",
  once per time outside the zone.
- **Manual Resume**: from the zone exit if you are outside it now, else from now.
- **Phone locked during the pause** (no position for 20 s or more) and back at least 2× the radius away: you
  walked on unseen. Resume from the first position seen outside the zone, else from the zone's edge
  toward you; the time walking is the straight distance × 1.3 at your pace before (capped at the hole),
  the rest stays paused; the stretch is filled as a **recording gap** (v0.13.0 rules). Back inside the zone
  or just outside it: still paused, watched as usual. **A pause itself is never a gap.**
- The pause is a **break in the walked line** and its own GPX `<trkseg>`; exported `<desc>` gives the paused
  time. Saved with the recording (`pausedMs`, `pause` = the watcher), so it survives a force-close and
  Resume re-enters it. Stop ends a pause (its time counts as Paused); Reset clears it.
- Simulated GPS stands still for a minute after Pause, then walks on.
- Tested 2026-11-12: unit tests with simulated picnics (`tests/pause-coords.test.js`: wandering inside for
  half an hour, leaving to carry on, back to the car then driving, pacing/slow asks, a track arc, phone
  locked, snapshot); headless browser (simulated GPS, synthetic DEM, faked router, no live relay): pause,
  auto-resume with the exit backdated, Undo, manual Resume, force-close while paused, GPX segments.

### Coordinates and points on the map (built in v0.14.0, requested 2026-11-12; awaiting iPhone testing)
- **Coordinate search** in Explore, read on the phone (`coords.js`, **no relay request**): decimal
  (`46.5679, 7.9123`, a space or `;` between), **decimal commas** with a space or semicolon between
  (`46,5679 7,9123`, `46,5679; 7,9123`), N/S/E/W letters before or after (longitude first if the letters
  say so), degrees-minutes-seconds and degrees-decimal-minutes, with or without ° ' ". Without letters:
  latitude first. Anything else is searched as a place as before.
- The parsed point is **shown first** (decimal and DMS) as the only result; tapping it goes there with a pin
  and the **point menu**: coordinates, **Copy** (decimal), **Start here**, **End here**.
- **Long-press** on the map (≈0.6 s, cancelled by moving the finger, dragging or zooming; right-click on the
  Mac; not while drawing in Plan) opens the same menu.
- **Start/End** are shown on Plan's start card ("From … → to …", Clear). **Draw a new track** then opens the
  planner with them joined by one trail segment (one routing request; straight when routing isn't set up),
  or with just the start. They are cleared once used.
- Tested 2026-11-12: unit tests for the formats and for place names that must not be read as coordinates;
  headless browser: both comma formats, no geocode request, Copy, right-click menu, Start/End into the
  planner with one (faked) route request.

### Walk finished, walks and tracks (built in v0.15.0, requested 2026-11-12; pushed 2026-11-13 with the user's OK, awaiting iPhone testing)
- **Every walk is saved and linked** (`saveWalkEntry` in `app.js`): on every Go › Stop the recording is saved
  to the Track Library as a **walk** (`kind: 'walk'`, one entry per recording, `hike.walkId`, kept with the
  recording so a force-close doesn't make a second one). Stop then Start (or Continue walk) updates the same
  entry. Linked to the loaded track when that is in the Track Library (`trackId`, plus `trackName`); the test
  loop and tracks not in the library aren't linked ("not in the library"). It keeps the walk's numbers
  (`stats`: walked, moving, stopped, paused, ascent, descent, gaps) and `recordedAt`. Elevations as before
  (DEM recorded while walking; missing ones filled from the DEM). "Save as track" buttons are now **Save walk**.
- **Walk finished** box on Go after Stop (only when something was recorded; over the trip panel):
  distance, moving, stopped, paused, ascent/descent, gaps; "Saved in Track Library › Walks as “…”". Buttons:
  **Done**, **Continue walk** (Start again, same walk), **Edit walk**, **Make a new track** (a track entry
  `Walk name · track` from the walk as it is now, edited or not, `fromWalk` link; the walk stays),
  **Update “Track”** (only when the walk is linked to a track in the library), **Export** (Export my hike),
  **Review gaps (N)** (only with gaps: Track Library gap review), **Discard** (confirm; deletes the walk
  entry and clears the recording).
- **Edit walk** (`walk-edit.js`, pure): sliders **Trim start**, **Trim end**, **Cut out a stretch** (From / To,
  distances along the walk; the two sides joined by a straight line), **Simplify** Off / Light (3 m) /
  Medium (10 m) / Strong (25 m) (Douglas-Peucker). Map preview: kept part pink, removed parts dark grey
  dashed, zoomed to the walk above the box; "Kept 4.21 km of 4.50 km · 812 points". **Save edited walk**
  replaces the walk's points, the recorded version kept (Restore). **Snap to trails (N requests)**: the edited
  walk simplified to at most **25** segments (the relay allows 30 a minute), each a trail segment routed by
  the planner (one request each, same fallbacks as the planner), opened in Plan as `Walk name · on trails`;
  Save there makes a new track linked to the walk. **Back**.
- **Update the track with this walk**: confirm, then the linked track's points become the walk's (planned
  segments dropped; waypoints kept where they are, re-located on load); the old version is kept. If that
  track is loaded it is reloaded.
- **Versions and Restore**: updating a track, saving an edited walk, saving over a track in Plan, and walking
  on after an edit keep the replaced version (`versions`, newest first, at most **5**; `versionReason` says what
  made the current one). Track Library › **Restore previous version** (confirm with both lengths) goes back one
  version; the loaded track is reloaded if it was that one (not during a hike).
- **Track Library** is split into **Tracks** and **Walks** (newest first). Under each row a line with its links
  and history: a walk: date, moving time, ascent, "along “Track”" or "free walk", what edited it; a track: its
  walks ("2 walks: dates"), "made from “Walk”", "updated with the walk of …". Entries from before v0.15.0
  have no `kind`: ids `walk-…` are walks, the rest tracks.
- Tested 2026-11-12: unit tests (`tests/walk-edit.test.js`: trim with elevations, cut, simplify, snap request
  cap, versions and Restore, links); headless browser (simulated GPS on the sample added to the library,
  faked router, no live relay): Stop → box saved and linked, Edit with trims/cut/simplify and preview, Save
  edited walk, Make a new track, Update the track, Restore, Continue then Stop (still one walk), Snap to
  trails (3 requests, saved as a linked track), Discard.

### Moving to trails.rinociardo.com (v0.15.1, requested 2026-11-13)
- Checked for the move: `manifest.webmanifest` `start_url`/`scope` are `./`, the service worker is registered
  as `sw.js` and caches `./…` paths, no absolute paths in the app: nothing changes at the root. Changed:
  the service worker no longer caches `./index.html` (Cloudflare Pages redirects `/index.html` to `/`, and
  Safari refuses a redirected answer for opening the app); offline opening uses `./`. GPX `creator` names
  the new address. The relay allows `https://trails.rinociardo.com` (redeploy needed), github.io kept.
- **Old address banner**: on `rinociardo.github.io` only (or with `?moved`), an amber banner on every opening
  "Trails has moved to trails.rinociardo.com. Export your tracks (Track Library) and import them there." (×
  hides it until the next opening), and the same note at the top of the Track Library.
- **Data doesn't move by itself** (storage is per address, and per Home Screen app on iOS): GPX export/import.
  To make that practical: **Export** on every Track Library row (without loading it); a walk is written with
  `<type>walk</type>` on its `<trk>` and comes back under Walks; **Import GPX** takes several files at once
  (all into the library, nothing loaded, unreadable files listed). User checklist: README "Moving your tracks
  and walks". Not carried by GPX: versions, links, a walk's stats and gap choices, plan segments, settings.
- Tested 2026-11-13: unit tests (walk type in GPX, relay accepts both addresses from `wrangler.toml`, refuses
  look-alikes); headless browser (no live relay): banner only with `?moved`, ×, library note, multi-import
  of a track, a walk and a broken file, row Export of a walk and re-import under Walks, offline opening
  from the service worker without `index.html` cached.

### Still to build
- **Trail scan** (Explore): the legacy prototype's "Scan for Trails" asked Overpass
  (overpass-api.de) for `highway=path` and `route=hiking` in the view and drew them. To
  propose: source (Overpass public instance has a fair-use policy) vs a hiking-trail
  overlay layer.
- **From → To** (Plan): search both ends with the place search, route between them (one
  relay `/route` request; segments of ≤ ≈50 km), turn the route into an editable plan.
- **Loop generator** (Plan), proposal 2026-10-29, not built: "N km/mi inside a rectangle I
  draw, with minimal overlap": openrouteservice `round_trip` (length, points, seed) from a
  start point, several candidates (different seeds/points), keep those inside the
  rectangle, score on overlap and length error, show the best 2–3. ≈8–12 routing requests
  per use. Needs a relay change (accept one point plus `round_trip`, length capped).
- **Coverage layer** (Explore), proposal 2026-10-29, not built: US FCC National Broadband
  Map mobile data (by provider/state/technology, H3 hexagons, offered free of copyright
  restriction per FCC wording) as a pre-built regional layer; Italy: AGCOM broadband map
  open data (licence and freshness to verify) and Infratel's 2024 4G/5G mapping (open data
  to verify); OpenCelliD towers (CC BY-SA 4.0) as a fallback hint. Plus a **personal
  coverage log**: while hiking, a tiny connectivity probe every 1–2 min stored with the
  position, shown as a layer (no signal strength or carrier on the web, foreground only).
- Stage 3 Prepare: offline map download for an area at the highest zoom available
  (needs the offline map source decision; must respect provider terms and storage limits).
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

- Run locally: `python3 -m http.server 8000`; tests: `npm test` (no network: recorded answers, see the
  trail-guide importer).
- Developer switches: `?sim` / `?sim=N` (replays the loaded track with noise, a stop and a
  120 m detour) and `?terrain=demo` (3D terrain preview over Innsbruck).
- Pure logic lives in `geo.js`, `elevation.js`, `tracker.js`, `walk.js`, `gaps.js`, `pause.js`, `coords.js`, `walk-edit.js`, `dem.js`, `plan.js`, `guide.js`, `units.js` and the writer in `gpx.js`, unit-tested in `tests/`;
  keep it free of browser APIs so it stays testable with Node. `dem-tiles.js` is the browser
  side of the DEM (fetch + decode PNG tiles); `planner.js` is the planner screen; `guide-import.js` the trail-guide importer; `router.js`
  the routing service and `geocoder.js` the place search (both through the relay in `relay/`,
  deployed separately to Cloudflare: redeploy it after changing `relay/`).
- Known gap: GPS does not run while the app is closed or in the background (iOS limit).
  Since v0.13.0 that time is filled by guessing the way (recording gaps), not measured.
