# Trails

A hiking Progressive Web App (PWA): open a GPX track, follow it with live GPS,
see distance done/remaining, and get an alert when you stray from the route.
With no track loaded, Start records a free walk that you can export as GPX or save as a
track; tracks without elevations get them from a DEM (Digital Elevation Model).

Live site: **https://trails.rinociardo.com/** (Cloudflare Pages, since v0.15.1). The old address
https://rinociardo.github.io/trails/ keeps working for a while, with a banner saying it has moved.

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout, styles, Apple Home Screen tags |
| `app.js` | Tabs (Explore, Plan, Go, Track Library, Settings), hike logic: GPX import, GPS, progress, off-track alerts, Wake Lock, dim mode, settings, updates |
| `guide.js` | Trail-guide importer logic: reads milestone sheets and CSV, finds place names, compares legs, places waypoints (unit-tested) |
| `guide-import.js` | Trail-guide importer screen (Plan) |
| `units.js` | km/m or mi/ft for everything shown (unit-tested); values stay in metres inside |
| `geocoder.js` | Place search (openrouteservice geocoding through the relay); the only file that talks to the search service |
| `geo.js` | Distance maths and "where am I on the track" (unit-tested in `tests/`) |
| `gpx.js` | Reads GPX files and writes them for export (unit-tested) |
| `elevation.js` | Ascent/descent (5 m threshold) and elevation at any point of the track (unit-tested) |
| `dem.js` | Elevations from DEM tiles: tile maths, terrarium decoding, interpolation (unit-tested) |
| `dem-tiles.js` | Downloads and decodes the DEM tiles in the browser (the last 48 in memory, up to 600 stored on the device for walking without signal); elevation at your position |
| `plan.js` | Track planning: points, segments, undo, sampling, slope, simplifying (unit-tested) |
| `planner.js` | The planner screen: map editing, trail routing and fallbacks, live totals, steep warning, save/export |
| `router.js` | Trail routing (openrouteservice); the only file that talks to the routing service |
| `relay/` | The Trails relay (Cloudflare Worker) holding the openrouteservice key: routes and place search; deployed separately, see `relay/README.md` |
| `walk.js` | Live walk numbers: ascent/descent from the DEM, current and vertical speed, off-track state, alert modes (unit-tested) |
| `gaps.js` | Recording gaps: how to fill them (straight, track, trail routes), time split, path and export runs (unit-tested) |
| `gap-fill.js` | Fills gaps in the background: route alternatives through the relay, DEM elevations, retry when back online |
| `pause.js` | Smart Pause: the pause zone and when you are back on the move (unit-tested) |
| `coords.js` | Coordinates typed in the search box: reading and showing them (unit-tested) |
| `walk-edit.js` | After a walk: trim, cut out, simplify, the snap-to-trails plan, walks/tracks, versions and Restore (unit-tested) |
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

## Publish

Every push to `main` publishes to both addresses: Cloudflare Pages (trails.rinociardo.com) and
GitHub Pages (the old address). To release a change: edit, bump `VERSION` in `sw.js`, commit,
`git push`.

### GitHub Pages (the old address, set up once)

```sh
cd ~/Projects/Trails
gh repo create rinociardo/trails --public --source=. --remote=origin --push
gh api -X POST repos/rinociardo/trails/pages -f "source[branch]=main" -f "source[path]=/"
gh api repos/rinociardo/trails/pages --jq '.status + "  " + .html_url'   # repeat until "built"
```


### Cloudflare Pages (trails.rinociardo.com, set up once)

rinociardo.com is registered at Porkbun, but its DNS (nameservers `aiden`/`sarah.ns.cloudflare.com`)
is on Cloudflare: DNS records are made in Cloudflare, not at Porkbun. On 2026-11-13 every host of
rinociardo.com, `trails` included (a wildcard), answered with a redirect to rinociardo-com.l.ink.

1. Cloudflare dashboard (the account that has rinociardo.com) › **Workers & Pages** › **Create
   application** › **Pages** › **Connect to Git** (if the page offers Workers first, look for the Pages
   option or "Looking to deploy Pages? Get started"). Choose **GitHub**, authorise Cloudflare for the
   `rinociardo/trails` repository only, select it, **Begin setup**.
2. **Project name** `trails` (it becomes `trails.pages.dev`, or `trails-xxxx.pages.dev` if taken).
   **Production branch** `main`. **Framework preset** None. **Build command** empty.
   **Build output directory** empty (the repository root; if the form insists, `/`). **Save and Deploy**.
   Wait for "Success", open the `….pages.dev` address: Trails opens.
3. The project › **Custom domains** › **Set up a custom domain** › `trails.rinociardo.com` ›
   **Continue**. Because rinociardo.com is on Cloudflare, it offers to create the DNS record itself:
   **Activate domain**. That record is `CNAME trails → <project>.pages.dev` (proxied). If it says a
   record for `trails` already exists: DNS › Records › edit or delete the existing `trails` record
   first (the `*` wildcard can stay: a named record wins over it). Nothing to do at Porkbun.
4. Wait until the domain shows **Active** (a few minutes; the certificate is issued then). Check:
   `curl -sI https://trails.rinociardo.com/sw.js` answers `HTTP/2 200`, not a redirect to l.ink.
   If it still redirects: Rules › Redirect Rules (and Page Rules) for a rule that covers all hosts.

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
   At about 3:30 a red OFF TRACK banner appears (no beep: the default is Banner only), Remaining shows "—" and the panel says "Off track: N m to the track", then "Back on track". The debug box shows a few **DISCARDED** fixes (deliberate bad fixes).
5. **Resume after a force-close.** In the Home Screen app: Settings › Testing › **Simulated GPS** on (the app reloads), load the sample track, press Start, and wait at least 30 s (Walked shows a distance). Swipe up to the app switcher and swipe Trails away. Reopen it from the Home Screen.
   *Expect:* a **Resume hike?** box with your walked distance, moving/stopped time and progress. Tap **Resume**: the numbers continue from there, the hike is running, and the map shows the track and dot (if the map stays blank, tell me: that would be the map's background worker failing).
   Repeat and tap **Start fresh**: everything resets, and the next reopen doesn't ask.
   At most the last 10 s of a recording can be lost. Since v0.13.0 the time the app was closed is filled as a recording gap (step 30).
   Afterwards, turn **Simulated GPS** off again (Settings › Testing) before any real walk.
6. **Sound check.** Settings › Alerts › Off-track alert › **Banner + sound**: it beeps right away. (Set it back to Banner only afterwards if you prefer no sound.) Try it with the side ring/silent switch on and off, and note whether you hear it.
7. **Real GPS.** Outdoors, from the Home Screen app: Settings › Testing › Test loop here, press Start, allow location.
   *Expect:* a blue dot with a pale accuracy circle and "GPS ±5–15 m". Walk the loop; Done increases.
   Walk about 60 m away from the line: within a few seconds you get the banner (and a beep with Banner + sound). Come back: it clears.
   **Stop test:** stand still for a minute. *Expect:* after 30 s "Stopped 0:30", Walked stops growing, and no off-track alarm. Walk on: "Moving", and Walked grows again.
   **Debug view** (Settings › Testing): orange dots are raw GPS fixes, blue dots the smoothed position, red rings discarded fixes, and a purple dashed circle the stop area. The blue trail should be steadier than the orange, about 2 s behind you.
   **Climb line** (debug box, needs a track with elevations: the test loop gets them from the DEM when created with signal, check the panel says `Elevation: 41 of 41 points · 41 from the DEM`): it shows how much the track elevation at your snapped position changed over the last 30 s, e.g. `Climb (track) 4.2 m in 30 s (net +4.1 m, 490 m/h); limit 3 m → not a stop` (with no track it uses the DEM: `Climb (DEM)`). Note the values (a) while climbing slowly on a steep part and (b) while standing still on a slope. Standing still is not exactly 0: GPS jitter moves your snapped point up and down the slope (about 1 m in the simulation). Pick a setting between the two (see "Settings to tune" below) and tell me the numbers.
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
   *Expect:* "No track · Start records a free walk"; the big numbers are **Walked / Moving / Speed** (not Done / Remaining / From track), and the panel shows the walk's numbers (step 27) and its profile: no table.
   **Simulated** (quick, indoors): Settings › Testing › Simulated GPS on and Debug view on, press Start. *Expect:* "Free recording (no track)", Walked and Moving grow, after about 50 s "Stopped" (the simulation pauses 45 s), never an OFF TRACK banner; the debug box says `Climb (DEM) …` and `Snapped –`. Force-close and reopen: **Resume hike?** with the walked distance; Resume continues from where it was.
   **Real** (outdoors, Simulated GPS off): press Start and walk a few hundred metres, stop for a minute, walk on, press Stop.
   *Expect:* a **pink line** on the map following where you walked (a short gap at the end is normal: it is redrawn every 5 s), and a **Save as track** link in the panel after Stop.
   Then Track Library › **Export my hike** › Save to Files. *Expect:* a file `Free-recording_2026-10-28.gpx` with an `<ele>` on the points (DEM elevations since v0.12.0) and a description like `Walked 1.20 km, moving 0:15:20, ascent 42 m, descent 40 m`. Only a walk recorded entirely with no signal, in an area not stored on the device, says `No elevation data`.
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
24. **Removing the test loop (v0.10.1).** Settings › Testing › Test loop here, then Track Library. *Expect:* Loaded track says "Test loop · … · temporary test track", with a red **Remove test loop** button.
   **With no hike:** tap it and confirm. *Expect:* "None" under Loaded track; force-close and reopen: no track, no prompt.
   **With a test hike:** create the loop again and press Go › Start (simulated is fine). After a few seconds, Track Library › **Remove test loop**. *Expect:* if a walk was recorded, **Keep your walk?** with Export / Save as track / Discard / Cancel (if not, a plain confirmation). Cancel: nothing changes and the hike keeps running. Tap Remove again › **Discard**: the hike stops and the loop is gone. Force-close and reopen: no track, no prompt, Current recording says "Nothing recorded".
   **After a force-close:** create the loop, Start, walk or simulate a little, force-close, reopen. *Expect:* the Resume prompt. **Start fresh** › Discard: the loop is gone at once, and stays gone on reopening.
   **Library copy:** create the loop, Add to library. *Expect:* its row says "loaded". Delete it and confirm: the row and the loaded loop both go.
25. **Trail-guide importer (v0.11.0).** Each read of a sheet uses 10–25 place searches of the shared quota. Plan › **Import a trail guide**, paste your club's sheet (the whole page is fine) › **Read the sheet**.
   *Expect:* a track name from the sheet, the count of milestones, "N other lines ignored" (open it: any contact paragraph is only listed there), numbered pins. Names you go *under*, *past* or *to* are turns, not places. A place not found says "No match near the route".
   **Confirm** the right ones. On a wrong or missing one: **Change** › search other text, pick a result, or **Tap the map**; dragging a pin works too. **Skip** leaves it as a waypoint. Correcting a place can bring back rows below it.
   **Route confirmed places.** *Expect:* the line follows the trails, and a table of sheet vs route for each leg. To see a flag: confirm a place on the wrong side of a river (more than 10% off: red in the table, orange on the map). **Change places** goes back; **Save to Track Library** keeps it; **Export GPX** shares it.
   **CSV:** make a file with the header `mile,place,note,restroom`, one row per milestone (no place = a waypoint; restroom `yes`). "Open CSV or text file". *Expect:* the same list, searching each place as written.
26. **Follow a trail guide.** Track Library › Load it (the row says how many waypoints), then Go. *Expect:* markers along the line, with a restroom icon at restroom milestones; tap one for its note. A dark box says e.g. "In 0.8 mi" and the next note (tap it for a long note). Start (Simulated GPS is fine): the distance counts down and the note moves on as you pass each one. **Dim** shows it too. **Reverse direction**: the notes come from the other end. Force-close and reopen: all still there.
   **Between devices:** Export GPX on the computer, AirDrop to the iPhone, Track Library › Import GPX. *Expect:* the same total, waypoints, notes and restrooms.

27. **Free walk numbers (v0.12.0).** Go with no track (Unload track if needed), Start. Simulated GPS is fine for a first look, but the speeds are then 10× too fast; a real walk of 15 minutes or more with some climbing is the real test.
   *Expect:* the top bar shows **Walked / Moving / Speed**. Under the profile, **My walk**: Walked, Moving, Stopped, Avg speed, Speed (now), Elevation, Ascent, Descent, Vertical (now, ↑ or ↓, or "level"), Avg up, Avg down. Elevation shows "…" for a second, then a value; Speed and Vertical show "–" for the first 20 s or so; Avg speed after 1 minute; Avg up / Avg down after a minute spent climbing / descending. While Stopped: Speed 0 and Vertical "level", and Ascent doesn't move.
   The profile above shows **your walk so far** (redrawn every 5 s), with a dot at the end. Compare Ascent with Maps 3D PRO for the same walk: both use a 5 m threshold here (Settings › Elevation).
   **Vertical speed units:** Settings › Units › Vertical speed › per minute, then per second. *Expect:* "7.0 m/min", "0.12 m/s" (or ft/min, ft/s).
   **After a force-close:** Ascent, Descent and the averages come back with the Resume prompt.
   **Save and export:** Stop, then Track Library › Export my hike and Save as track. *Expect:* the exported file has elevations and its description gives ascent and descent; the saved walk's profile matches the one you saw on Go.
28. **No signal (v0.12.0).** Elevations come from DEM tiles (about 1.7 km each), stored on the device once downloaded.
   **Same area again:** after step 27 (or after loading a track there with signal), turn on Airplane Mode (keep Location Services on), reopen Trails, Go › Start in the same area. *Expect:* Elevation and Ascent work as before.
   **New area:** Settings › Elevation › **Clear stored elevation tiles** (it shows how many are stored), Airplane Mode on, Start. *Expect:* Elevation says "unavailable" and a line explains why; turn Airplane Mode off: within about 20 s the elevation is back and Ascent carries on.
29. **Following a track (v0.12.0).** Load the sample (Settings › Testing) with Simulated GPS on, Go › Start.
   *Expect:* the top bar shows Done / Remaining / From track, the table Done / Remaining / Total, and the walk's own numbers (step 27) below as well. The status line has an **Alerts: banner only** button.
   At the detour (about 3:30 at 10× speed): **Remaining** in the top bar and the table's Remaining column show **"—"**, the third number is labelled **Off track**, a red line says "Off track: 120 m to the track", and the red OFF TRACK banner shows, **without sound**. Back on the track: Remaining comes back.
   **Quick toggle:** tap **Alerts:** during the hike. *Expect:* banner only → banner + sound (it beeps once) → off (no banner, but the "Off track" line and "—" still show) → banner only. A toast says it is for this hike only; Settings › Alerts keeps its choice. Force-close and reopen: Resume keeps the hike's choice; loading another track goes back to the Settings one.
   **Settings › Alerts › Off-track alert:** Off / Banner only / Banner + sound. It starts at **Banner only** even if sound was on before v0.12.0.
   On a planned track's straight (dashed) segments the wider limit applies (100 m by default) to the numbers as well as the banner.
   **Profile:** Track / **My walk** above the profile switches between the planned track (marker where you are) and your walk so far; Explore always shows the track.

30. **Recording gaps (v0.13.0).** Route alternatives need the relay from v0.13.0 (redeployed 2026-11-12; see `relay/README.md`, "Updating the relay"); an older relay still fills gaps, with one route each.
   **Simulated** (indoors): Settings › Testing › Simulated GPS on, no track, Go › Start, wait 20 s, then Settings › Testing › **Simulate a 1-minute GPS gap**. *Expect:* on Go, after about a minute, a toast "Paused 1 min, filled from trails (… m)"; Walked jumps by that distance; the pink line has a **dashed** stretch. Stop, Track Library: **Gaps in the recording** lists it ("… along trails · 2 other options"). **Show**: the map shows the gap, the chosen route pink, the others grey and dashed; tap a grey line (or its button): it turns pink and Walked changes. Done.
   **No signal:** Airplane Mode on (Location stays on), simulate another gap. *Expect:* "…: no signal: filled when back online; straight for now". Airplane Mode off: within a minute "…filled from trails".
   **On a track:** load the sample, Start (simulated), simulate a gap. *Expect:* "Paused 1 min, filled along the track" (no request needed).
   **Real, screen locked:** outdoors, Go › Start, walk a minute, **lock the phone** and keep walking 5–10 minutes along a path (ideally with a fork), unlock and open Trails. *Expect:* within a few seconds "Paused 7 min, filled from trails (… m)", Walked and Moving include the gap, and Stopped grows only if you walked slower than your pace before. **Standing still:** stand still until Go shows **"Stopped"**, then lock the phone for a few minutes without moving. *Expect:* "Paused …: you hadn't moved", and Stopped grows. (Locked while still "Moving" and then standing still gives "Paused 5 min, filled straight (12 m)" instead, with most of the time as Stopped.)
   **Real, app closed:** Start, walk, swipe Trails away in the app switcher, walk 5 minutes, reopen, **Resume**. *Expect:* the same kind of toast; the pink line carries on (dashed across the gap) instead of starting a new piece.
   **Export my hike:** *Expect:* each gap is a segment of its own; its points say `<type>Gap filled with a trail route (a guess)</type>` and the filled ones `<fix>none</fix>`; the description says how many gaps were filled.
   **Setting:** Settings › Recording gaps › "Fill gaps with routes walkable at up to (km/h)", 7 by default (or mph, 4.5): lower it and routes that would need a faster walk are left out (the gap then shows "too long or too fast for walking", drawn straight).

31. **Smart Pause (v0.14.0).** Pause is for a long break (a picnic, a summit, a café); **Stop** is still for ending or interrupting the hike.
   **Simulated** (indoors): Settings › Testing › Simulated GPS on, Go › Start, wait 20 s, press **Pause** (next to Start). *Expect:* a toast "Paused. Nothing counts until you leave the 150 m zone…", an amber circle on the map, the status line "Paused 0:05" counting up, the button now says **Resume**, and in the panel Walked, Moving and Stopped stop changing while **Paused** grows. The simulation stands still for a minute, then walks on. *Expect:* about a minute after it leaves the circle, a banner "Resumed: you're back on the move. **Undo**" (no sound); Walked and Moving now include the walk since it left the circle, and the pink line starts a new piece there (a gap in the line where the pause was).
   **Undo:** tap **Undo** on that banner. *Expect:* back to Paused, the numbers as they were at the pause, and "Still paused. Press Resume when you set off again." It won't resume by itself again during this pause; press **Resume**: counting starts from that moment.
   **Force-close while paused:** Pause, swipe Trails away, reopen, **Resume**. *Expect:* still Paused (circle, timer, Resume button); Paused in the panel includes the time it was closed.
   **Export my hike:** *Expect:* one `<trkseg>` before and one after each pause; the description ends with "paused m:ss".
   **Real, picnic:** outdoors, walk a few minutes, press Pause, then walk around within about 100 m for 10 minutes. *Expect:* nothing counts and no banner. Then carry on the hike. *Expect:* about a minute after leaving the circle, "Resumed…", with the distance counted from where you left the circle.
   **Real, back to the car:** Pause at the end of a walk and walk back to the car (out of the circle). *Expect:* "Resumed…" after a minute: tap **Undo**; driving off then doesn't resume it. Press Stop.
   **Real, locked during the pause:** Pause, lock the phone, sit 5 minutes, then walk on 5–10 minutes with the phone locked, unlock. *Expect:* "Resumed…" with Undo, the walk from the circle's edge filled like a recording gap (step 30: dashed, toast "…filled from trails"); the minutes you sat stay Paused, not Moving. Locked but still in the circle when you unlock: still Paused.
   **Unclear:** outside the circle but pacing back and forth (or very slow). *Expect:* "Still paused. Resume?" once; **Resume** resumes, × closes it.
   **Setting:** Settings › Pause › "Pause zone radius" (default 150 m / 500 ft): a smaller zone resumes sooner after you leave.

32. **Coordinates (v0.14.0).** Explore, type in the search box and press Enter (Search on the keyboard): `46.5679, 7.9123`, then `46,5679; 7,9123` (decimal commas), `46°34'4.4"N 7°54'44.3"E`, `N46.5679 E7.9123`. *Expect:* each time one result "Coordinates (read on the phone, no search)" showing the point in decimal and in degrees-minutes-seconds, **before** the map moves; it works in Airplane Mode. Tap it: the map goes there with a pin and a small menu: the coordinates, **Copy**, **Start here**, **End here**. Copy, then paste in Notes: *expect* "46.56790, 7.91230". A place name (e.g. `Wengen`) still searches as before.
   **Long-press:** hold a finger on the map for about half a second (right-click on the Mac). *Expect:* the same menu for that spot (no search). Moving the finger or pinching doesn't open it; it doesn't open while drawing in Plan.
   **Start and end:** **Start here** on one point and **End here** on another. *Expect:* a toast, and on Plan "From … → to …. Draw a new track starts there. Clear". **Draw a new track**: *expect* the planner with the two points joined by a trail (one routing request; straight if routing is down). With only a start: the planner starts with that point. **Clear** forgets them.

33. **Walk finished, walks and tracks (v0.15.0).** Since v0.15.0 the "Save as track" buttons say **Save walk** and every walk is saved by itself when you press Stop (Track Library › **Walks**).
   **Set up** (simulated is fine): Settings › Testing › Simulated GPS on, **Load sample track**, then Track Library › Loaded track › **Add to library** (so your walk can be linked to it). Go › **Start**, wait 30 s, **Stop**.
   *Expect:* a **Walk finished** box over the panel: distance · moving · stopped (· paused) · ↑ ↓ (· gaps), "Saved in Track Library › Walks as “Sample loop… (walked …)”", and the buttons **Done**, **Continue walk**, **Edit walk**, **Make a new track**, **Update “Sample loop…”**, **Export**, **Discard** (plus **Review gaps (N)** if there were gaps).
   **Edit walk:** move **Trim start** and **Trim end**: the removed ends turn dark grey and dashed, the rest stays pink, and "Kept … of … · N points" follows. Tick **Cut out a stretch** and move **From** / **To**: that part goes grey and the two sides are joined by a straight line. **Simplify** Medium: fewer points. The button reads **Snap to trails (N requests)**. **Save edited walk**. *Expect:* "Saved the edited walk (…)". Track Library › Walks: the walk shows its new length, "along “Sample loop…”", "edited (trimmed, cut or simplified)" and **Restore previous version**.
   **Make a new track:** *Expect:* a toast, and Track Library › Tracks has "… · track" with "made from “…”".
   **Update “Sample loop…”:** a confirmation names both lengths; OK. *Expect:* "Updated “Sample loop…” with this walk"; the blue track on the map is now your walk; in Tracks the sample says "1 walk: …", "updated with the walk of …" and **Restore previous version**. Tap Restore, OK: the full loop is back (7.30 km).
   **Continue walk:** Go, Start or **Continue walk**, walk 10 s, Stop. *Expect:* still **one** walk in Walks (the same one, longer).
   **Snap to trails:** Edit walk, then **Snap to trails (N requests)**. *Expect:* Plan opens with "… · on trails", the segments turn into trails one by one (N requests, straight if routing is down); **Save** puts a new track in Tracks with "made from “…”".
   **Discard:** Start, Stop, **Discard**, OK. *Expect:* the box closes, the walk is gone from Walks, and Go's numbers are cleared.
   **Real walk:** follow a saved track outdoors, Stop at the end. *Expect:* the same box; trim off the drive to the trailhead with **Trim start** and save; Export; the walk and the track show each other in the Track Library.

34. **Moving to trails.rinociardo.com (v0.15.1).** After the Cloudflare set-up (see "Publish").
   **Old address:** open the old Home Screen app (or `rinociardo.github.io/trails/` in Safari). *Expect:* an amber banner "Trails has moved to trails.rinociardo.com. Export your tracks (Track Library) and import them there." with ×; × hides it until the app is opened again; Track Library shows the same note at the top. (On the computer, `?moved` shows them at any address.)
   **Export from a row:** Track Library › **Export** on a track, then on a walk: the Share sheet opens with that file, without loading it.
   **New address:** follow "Moving your tracks and walks" below. *Expect:* Import GPX with several files selected says "Imported N tracks and M walks into the Track Library", walks land under **Walks**, tracks under **Tracks**, nothing is loaded. Place search and Plan's trail routing work there (they need the relay redeployed for v0.15.1). Settings › This device: **0.15.1**. Airplane Mode, reopen from the Home Screen: it opens.

### Moving your tracks and walks (iPhone)

Each address keeps its own data on the phone, and so does each Home Screen icon (a Home Screen app
doesn't share storage with Safari). Your tracks and walks are in the **old Home Screen app**.

1. **Old app** (the Trails icon you have now): if a walk is running, Stop it (it is saved as a walk).
2. Track Library: for each track and each walk you want, **Export** › **Save to Files** › one folder
   (e.g. iCloud Drive › *Trails move*). Same names on one day get "(1)" added by Files: that's fine.
3. In **Safari**, open **trails.rinociardo.com** › Share › **Add to Home Screen** › Add.
4. Open the **new** icon (not Safari: Safari's copy would not be seen by the Home Screen app).
   Allow location when asked, then set Settings again (units, alerts, pause zone, elevation threshold):
   settings don't move.
5. Track Library › **Import GPX** › the *Trails move* folder › **Select** (top right) › select them
   all › **Open**. Check the counts in the message, and that walks are under Walks.
6. Load one track and check its totals against the old app.
7. Keep the old icon until you're happy; then press and hold it › Remove App (that deletes its data).

What doesn't move with GPX: earlier versions (Restore), the links between walks and tracks, a walk's
moving/stopped times and gap choices, a planned track's trail/straight segments (Edit in Plan works on
the line), downloaded elevation tiles (fetched again when needed) and the settings.

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
