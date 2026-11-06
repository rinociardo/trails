# Trails

A hiking Progressive Web App (PWA): open a GPX track, follow it with live GPS,
see distance done/remaining, and get an alert when you stray from the route.
With no track loaded, Start records a free walk that you can export as GPX or save as a
track; tracks without elevations get them from a DEM (Digital Elevation Model).

Live site (once published): https://rinociardo.github.io/trails/

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout, styles, Apple Home Screen tags |
| `app.js` | Tabs (Explore, Plan, Go, Track Library, Settings), hike logic: GPX import, GPS, progress, off-track alerts, Wake Lock, dim mode, settings, updates |
| `units.js` | km/m or mi/ft for everything shown (unit-tested); values stay in metres inside |
| `geocoder.js` | Place search (openrouteservice geocoding through the relay); the only file that talks to the search service |
| `geo.js` | Distance maths and "where am I on the track" (unit-tested in `tests/`) |
| `gpx.js` | Reads GPX files and writes them for export (unit-tested) |
| `elevation.js` | Ascent/descent (5 m threshold) and elevation at any point of the track (unit-tested) |
| `dem.js` | Elevations from DEM tiles: tile maths, terrarium decoding, interpolation (unit-tested) |
| `dem-tiles.js` | Downloads and decodes the DEM tiles in the browser (keeps the last 48 in memory) |
| `plan.js` | Track planning: points, segments, undo, sampling, slope, simplifying (unit-tested) |
| `planner.js` | The planner screen: map editing, trail routing and fallbacks, live totals, steep warning, save/export |
| `router.js` | Trail routing (openrouteservice); the only file that talks to the routing service |
| `relay/` | The Trails relay (Cloudflare Worker) holding the openrouteservice key: routes and place search; deployed separately, see `relay/README.md` |
| `tracker.js` | GPS smoothing, moving/stopped detection, walked distance and times, the walked path for export (unit-tested) |
| `profile-chart.js` | The elevation profile chart in the trip panel |
| `map-view.js` | Everything MapLibre: track, position dot, follow mode, 3D terrain hook |
| `map-config.js` | Map sources: basemap tiles and (later) elevation for 3D/hill shading |
| `sw.js` | Service worker: offline start-up and updates. **Bump `VERSION` on every release.** |
| `manifest.webmanifest`, `icons/` | Install as an app |
| `vendor/maplibre-gl/` | MapLibre GL JS 6.11.2, served locally so the app starts offline |
| `samples/sample-loop.gpx` | Synthetic 7.3 km loop with elevations, for testing |
| `legacy/` | The original "Scan for Trails" prototype, kept for reference only |

No build step: the files are served exactly as they are.

## Run locally

```sh
python3 -m http.server 8000     # then open http://localhost:8000
npm test                        # unit tests: geometry, elevation, smoothing, stops (Node 20+)
```

Developer switches (add to the address):

- `?sim`: pressing Start replays the loaded track (with no track loaded: a 2 km square from the map centre or the last recorded point, for free recording) at 10× walking speed with realistic GPS noise, some bad fixes, a 45 s stop at 15% of the way and a 120 m detour at 30–38%, so you can see stop detection and the off-track alert without walking. `?sim=20` goes 20× (smoothing lag grows with speed, so very high values can cause false off-track alerts).
- `?terrain=demo`: previews 3D terrain and hill shading over Innsbruck, using MapLibre's demo elevation tiles.

## Publish to GitHub Pages

```sh
cd ~/Projects/Trails
gh repo create rinociardo/trails --public --source=. --remote=origin --push
gh api -X POST repos/rinociardo/trails/pages -f "source[branch]=main" -f "source[path]=/"
gh api repos/rinociardo/trails/pages --jq '.status + "  " + .html_url'   # repeat until "built"
```

To release a change: edit, bump `VERSION` in `sw.js`, commit, `git push`.

## iPhone test plan

The steps are in the order you should run them.

1. **Install.** Open the site in Safari, tap Share › Add to Home Screen, and open Trails from the icon.
   *Expect:* the dark green mountain icon; the app opens with no Safari address bar, and the top bar is dark green behind the clock.
   Settings › This device › Running as shows **Home Screen app**.
2. **Track.** Settings › Testing › Load sample track (or Track Library › Import GPX › pick a file from Files).
   *Expect:* a blue loop, with the track name and length in the top bar. Quit the app from the app switcher and reopen it: the track is still there.
3. **Elevation, before starting.** With the sample track loaded, look at the panel above the toolbar.
   *Expect:* `7.30 km · ↑ 225 m · ↓ 223 m`, a profile chart, and the Total/Remaining columns filled (Done shows –). Drag a finger along the chart: it shows distance and elevation.
   Load one of your own GPX files that you also have in Maps 3D PRO and compare ascent/descent (see "Comparing with Maps 3D PRO" below).
4. **Simulation.** Turn on Settings › Testing › **Simulated GPS** (or open the site with `?sim` in a Safari tab), turn on Settings › Testing › Debug view, set Auto-dim to Never (so the screen stays on the map), load the sample track, press Start.
   *Expect:* Done/Remaining and the profile marker move. At about 1:50 the top bar shows **Stopped 0:30** and the timer keeps counting; Walked stays still. At about 2:05 it says Moving again.
   At about 3:30 a red OFF TRACK banner appears with a beep, then "Back on track". The debug box shows a few **DISCARDED** fixes (deliberate bad fixes).
5. **Resume after a force-close.** In the Home Screen app: Settings › Testing › **Simulated GPS** on (the app reloads), load the sample track, press Start, and wait at least 30 s (Walked shows a distance). Swipe up to the app switcher and swipe Trails away. Reopen it from the Home Screen.
   *Expect:* a **Resume hike?** box with your walked distance, moving/stopped time and progress. Tap **Resume**: the numbers continue from there, the hike is running, and the map shows the track and dot (if the map stays blank, tell me: that would be the map's background worker failing).
   Repeat and tap **Start fresh**: everything resets, and the next reopen doesn't ask.
   At most the last 10 s of a recording can be lost; time while the app was closed is not counted.
   Afterwards, turn **Simulated GPS** off again (Settings › Testing) before any real walk.
6. **Sound check.** Settings › Alerts › turn Sound off and on: it beeps right away. Try it with the side ring/silent switch on and off, and note whether you hear it.
7. **Real GPS.** Outdoors, from the Home Screen app: Settings › Testing › Test loop here, press Start, allow location.
   *Expect:* a blue dot with a pale accuracy circle and "GPS ±5–15 m". Walk the loop; Done increases.
   Walk about 60 m away from the line: within a few seconds you get the banner and a beep. Come back: it clears.
   **Stop test:** stand still for a minute. *Expect:* after 30 s "Stopped 0:30", Walked stops growing, and no off-track alarm. Walk on: "Moving", and Walked grows again.
   **Debug view** (Settings › Testing): orange dots are raw GPS fixes, blue dots the smoothed position, red rings discarded fixes, and a purple dashed circle the stop area. The blue trail should be steadier than the orange, about 2 s behind you.
   **Climb line** (debug box, needs a track with elevations: the test loop gets them from the DEM when created with signal, check the panel says `Elevation: 41 of 41 points · 41 from the DEM`): it shows how much the track elevation at your snapped position changed over the last 30 s, e.g. `Climb 4.2 m in 30 s (net +4.1 m, 490 m/h); limit 3 m → not a stop`. Note the values (a) while climbing slowly on a steep part and (b) while standing still on a slope. Standing still is not exactly 0: GPS jitter moves your snapped point up and down the slope (about 1 m in the simulation). Pick a setting between the two (see "Settings to tune" below) and tell me the numbers.
8. **Wake Lock.** While hiking, the top bar shows **Screen awake**. Leave the phone untouched for 2 minutes.
   *Expect:* after 1 minute the screen goes black with large dim numbers (auto-dim), but the phone does **not** lock.
9. **Background.** Press Start, switch to another app for 1 minute, come back.
   *Expect:* "Screen awake" again, and GPS updates resume (the status may briefly say "no fix for N s"). GPS does **not** run while the app is in the background: this is an iOS limit.
10. **GPX export and AirDrop** (Mac → iPhone).
   On the Mac, open https://rinociardo.github.io/trails/ in Safari, import one of your GPX files (Track Library › Import GPX), and note the totals in the panel (distance, ↑, ↓). Track Library › **Export track**: the Share sheet opens; choose **AirDrop** › your iPhone. (In Chrome or Firefox on the Mac the file downloads instead; AirDrop it from Finder.)
   On the iPhone, save it to Files when asked, then in Trails: Track Library › Import GPX › pick it.
   *Expect:* the same name, distance, ↑ and ↓ as on the Mac, and the same profile shape. The file name looks like `Trackname_2026-10-28.gpx`.
   **Your hike:** after a walk (or the simulation in step 4), Track Library › **Export my hike** › Save to Files or AirDrop to the Mac. Open it in Maps 3D PRO or another app: the line follows where you walked, with a time on every point; stops show as a time gap at one spot, and each Stop/Start makes a new segment. Its length is within a few % of "Walked" (the file keeps a point every 5 m).
11. **Free recording (no track).** Go › **Unload track**. Check the top bar.
   *Expect:* "No track · Start records a free walk"; the big numbers are **Walked / Moving / Avg speed** (not Done / Remaining / From track), and the panel shows only the Walked/Moving/Stopped/Avg row: no table, no profile.
   **Simulated** (quick, indoors): Settings › Testing › Simulated GPS on and Debug view on, press Start. *Expect:* "Free recording (no track)", Walked and Moving grow, after about 50 s "Stopped" (the simulation pauses 45 s), never an OFF TRACK banner; the debug box says `Climb – (no track)` and `Snapped –`. Force-close and reopen: **Resume hike?** with the walked distance; Resume continues from where it was.
   **Real** (outdoors, Simulated GPS off): press Start and walk a few hundred metres, stop for a minute, walk on, press Stop.
   *Expect:* a **pink line** on the map following where you walked (a short gap at the end is normal: it is redrawn every 5 s), and a **Save as track** link in the panel after Stop.
   Then Track Library › **Export my hike** › Save to Files. *Expect:* a file `Free-recording_2026-10-28.gpx`; in the Files app's preview or a text editor it begins with `No elevation data (GPS altitude is not used)`. Open it with Open GPX (with signal): it loads as a track with your walk's shape, and gets elevations from the DEM (see step 14).
12. **Keep your walk?** Record a short free walk (step 11, simulated is fine) and do **not** export it. Then Settings › Testing › Load sample track.
   *Expect:* a **Keep your walk?** box: Export / Save as track / Discard / Cancel. **Cancel**: nothing changes. Try again and tap **Export**, then close the Share sheet without choosing anything: the box stays. Choose Save to Files: the sample loads.
   Record another walk, load the sample, tap **Save as track**. *Expect:* "Saved “Walk 2026-10-28 15:40” in the Track Library", then the sample loads. Settings › **Saved walks** › Load: your walk is the track; the panel says `Elevation: N of N points · N from the DEM (Terrain Tiles)` and the profile shows its ups and downs. Delete removes it.
   Also with a track: walk part of the sample (simulation), Stop: the pink walked line sits on top of the blue planned track. Then Settings › Testing › Load sample track again (or Open GPX): the same **Keep your walk?** box appears, naming the track ("along “Sample loop…”"). Settings › Reset walked/time asks the same while the walk is unsaved; after Export or Save as track it only asks "Reset walked distance…?".
13. **Reopening.** Settings › Testing › Test loop here, then force-close and reopen without pressing Start. *Expect:* no track (the test loop is not kept) and the map opens **on your position**. Repeat with Start pressed before the force-close: the loop is back with the Resume prompt.
14. **Elevations from the DEM.** With signal, import one of your GPX files (Track Library › Import GPX) that has no elevations (or the exported free walk from step 11).
   *Expect:* for a second the panel says "getting … points from the DEM", then `Elevation: N of N points · N from the DEM (Terrain Tiles)` and ↑/↓ totals. A GPX with its own elevations says `Elevation: all N points from the file`. Compare with Maps 3D PRO on a familiar route: within a few % (summits come out a little low on the DEM's 30 m grid).
   **Offline:** Airplane Mode, open such a file. *Expect:* "DEM not reachable (offline?)"; turn Airplane Mode off and the elevations fill in by themselves (or Go › Fill elevations).
15. **Plan a track on the Mac.** Open https://rinociardo.github.io/trails/ in Safari.
   No key or setup: routes come through the Trails relay (see `relay/README.md`). Settings › Planning has no key field any more.
   Plan › **Draw a new track**. *Expect:* a top bar with the name field, a hint and the openrouteservice credit; the toolbar shows Undo / **Next: Trail** / Save / Export / Done; the pointer is a crosshair over the map.
   Click 4–5 places along paths you know. *Expect:* after a moment each new segment becomes a **solid** purple line following the footpaths (it is faint while it is being looked up), between green (start) and red (end) points, and in the panel `2.35 km · ↑ 320 m · ↓ 120 m · 5 points` with a profile.
   **Straight:** tap **Next: Trail** so it says **Next: Straight**, and click a point across open ground: a **dashed** straight segment. Tap the small circle in the middle of any segment to switch it between trail and straight (Undo switches it back).
   **Fallbacks** (messages appear in a dark box at the top of the map): click a point far from any path (in a lake, a field): "no trail found… drawn straight". Click a point where the path would make a long detour (across a river with the bridge far away): "the trail would be 4.2× the straight distance… drawn straight" (the limit is 3×). Switch on Airplane Mode (or turn Wi-Fi off on the Mac) and add a trail segment: "Trail routing unavailable right now: drawn straight". When the relay's limit is reached: "Routing limit reached: drawn straight". Planning keeps working in every case, never an error box.
   **Move:** drag a point (the pointer becomes a hand over it): the line and totals follow. **Delete:** click a point. **Insert:** drag one of the small circles in the middle of a segment. **Undo** (or Cmd+Z) reverses each step; a drag is one step.
   **Steep:** add a point so a straight line crosses a steep slope (a valley side, a cliff). *Expect:* that segment turns orange and the box at the top says e.g. "⚠ Straight segment 2 crosses slopes up to 34° (68%); the warning starts at 20° (36%)". Settings › Planning sets the limit (default 20°). Trail segments never warn.
   Type a name, **Save**: "Saved … in the Track Library". **Export**: the Share sheet (or a download) with `Name_2026-10-28.gpx`; Maps 3D PRO should show the same line and similar ↑/↓. **Done** leaves the planner.
   Track Library › **Edit** on it: the same points come back; change one, Save, and Load it: the new version.
   **Edit a recorded walk:** Edit on a saved walk shows its path as many points on solid lines (trail segments); Save makes a new entry `… (edited)` and keeps the walk.
16. **Plan on the iPhone/iPad.** Same as step 15 with a finger: tap to add, press and drag a point, tap a point to delete, drag a middle circle to insert. Pinching zooms the map without moving points. Note anything fiddly (points too small, a tap taken as a drag).
17. **Follow a planned track.** Load the planned track from the Track Library and go out (or simulate with Settings › Testing › Simulated GPS).
   *Expect:* the normal hike screen. On straight (dashed) segments the off-track alert waits until you are more than Settings › Alerts › "…on straight segments" away (default 100 m instead of 50 m).
18. **Offline.** Open the app once with signal, then switch on Airplane Mode and reopen it from the Home Screen.
   *Expect:* the app opens, with your track and live position. The map background may be blank: offline map tiles are not built yet.
19. **Update.** After a new version is published, open the app with signal.
   *Expect:* a "New version installed — Reload" banner. Settings › App version shows the new number.

20. **Tabs (v0.10.0).** The bottom bar has **Explore · Plan · Go · Track Library · Settings**; the tab you were on comes back when you reopen the app.
   *Expect:* Explore: search box, Locate me, Layers. Plan: "Draw a new track", "Edit the loaded track" (greyed with no track), From → To and Loop generator greyed "(planned)". Go: the hike screen (Start / Center / Dim, numbers, profile, Reverse direction · Fill elevations · Unload track). Track Library: your saved tracks and walks (Load / Edit / Delete), Import GPX, New track, Export track, Add to library, Export my hike, Save as track, Reset walked/time. Settings: preferences only.
   **Hike while switching:** Go › Start (simulated is fine), then tap Explore and Track Library. *Expect:* a red dot on Go, the numbers keep counting when you come back, and the off-track banner shows on any tab. Plan › Draw a new track says "Stop the hike first".
   **Leave the planner:** draw two points, then tap another tab. *Expect:* "Leave the planner without saving your changes?"; Cancel keeps you in Plan.
21. **Nothing lost.** Every button of the old Settings page has a new home: Load sample / Test loop → Settings › Testing; Open GPX → Track Library › Import GPX (it now also adds the file to the library); Reverse / Fill elevations / Remove track (now "Unload track", library copies are kept) → Go, under the profile; Saved walks, New track, Export, Save my walk as track, Reset walked/time → Track Library.
22. **Units.** Settings › Units › **miles and feet**. *Expect:* everything switches at once: top bar, table, profile axes (ft, mi), planner totals, the toast after Locate me, the debug box, and the Settings fields (Off-track distance 160 ft for 50 m, the labels say "(ft)"). Type 200 ft, switch back to km and m: it shows 61 m. Export a track: the file still has metres (the GPX standard), and its description says "Distance 4.54 mi, ascent 739 ft, descent 731 ft".
   The first time, the units follow the phone's region (United States: miles and feet; Italy: km and m).
23. **Place search.** Needs the relay redeployed with search (see `relay/README.md`). Explore › type "Tre Cime di Lavaredo" › Search (or the keyboard's Search key).
   *Expect:* a short list (peak, town, address… with the kind under each name); tap one: the map flies there and drops a pin. Nothing is searched while you type. Clear the field: the pin goes. Offline: "Place search unavailable right now (offline?)".
   **Locate me:** *Expect:* the map jumps to you with the blue dot and "You are here (±5 m)".

### If Wake Lock fails

The top bar says **Screen may lock — tap to retry**, or the phone locks during step 8:

- Tap that message once (some iOS versions only grant Wake Lock right after a tap).
- Check Settings › This device › Screen wake lock. "Not supported" means your iOS is too old: update iOS (Wake Lock in Home Screen apps was reportedly unreliable before iOS 18.4).
- Turn off Low Power Mode: it can override Wake Lock.
- Fallback: iPhone Settings › Display & Brightness › Auto-Lock › **Never** for the hike (and set it back afterwards).
- Note which iOS version you have and what the status said: that tells us whether a workaround is needed.

### Comparing with Maps 3D PRO

Ascent/descent are counted with a **5 m threshold**: a climb or drop only counts once it exceeds 5 m, which removes GPS/elevation noise. Apps differ here, so the same GPX can show different totals. To compare:

1. Load the same GPX in both apps and note total ascent/descent.
2. In Trails, change Settings › Elevation › "Ignore climbs/drops smaller than" (try 2, 3, 5, 10 m) and see which value matches Maps 3D PRO best.
3. Tell me the value; I'll make it the default.

### Settings to tune on a real walk

| Setting | Default | Raise it if… | Lower it if… |
|---|---|---|---|
| Ignore fixes worse than | 30 m | too many fixes are discarded in forests/valleys | the dot jumps around |
| Average the last N fixes | 5 (≈2 s / ≈3 m lag) | the dot is jittery | the dot trails too far behind you |
| Stopped when within | 15 m | short stops are missed | slow climbs are marked "Stopped" |
| …for at least | 30 s | brief pauses count as stops | you want stops recognised sooner |
| …unless the track climbed more than | 3 m (= 360 m/h) | standing on a steep slope isn't detected as a stop | slow steep climbs still show "Stopped" |
| Off-track distance on straight segments | 100 m | cross-country parts alert too often | you want to stay closer to the line |
| Steep-slope warning (planner) | 20° (36%) | the warning shows on slopes you find fine | it misses slopes you'd avoid |
