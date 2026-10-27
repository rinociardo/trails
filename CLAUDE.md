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

### Requested next (2026-10-27, details pending from the user)
- **Elevation profile** of the track.
- **Position smoothing** (steadier GPS position).
- **Standing detection** (recognise when I'm stopped).
The user referred to "earlier messages" describing these, but those details were never
given in this project's conversations. Get the specifics before building.

### Still to build
- Stage 3 Prepare: offline map download for an area at the highest zoom available
  (needs the offline map source decision; must respect provider terms and storage limits).
- Stage 2 Plan: create a route on the map; GPX export.
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
- Developer switches: `?sim` (replays the loaded track with a 120 m detour) and
  `?terrain=demo` (3D terrain preview over Innsbruck).
