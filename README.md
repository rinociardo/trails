# Trails

A hiking Progressive Web App (PWA): open a GPX track, follow it with live GPS,
see distance done/remaining, and get an alert when you stray from the route.

Live site (once published): https://rinociardo.github.io/trails/

## Files

| File | What it does |
|---|---|
| `index.html` | Page layout, styles, Apple Home Screen tags |
| `app.js` | Hike logic: GPX import, GPS, progress, off-track alerts, Wake Lock, dim mode, settings, updates |
| `geo.js` | Distance maths and "where am I on the track" (unit-tested in `tests/`) |
| `gpx.js` | Reads GPX files |
| `map-view.js` | Everything MapLibre: track, position dot, follow mode, 3D terrain hook |
| `map-config.js` | Map sources: basemap tiles and (later) elevation for 3D/hill shading |
| `sw.js` | Service worker: offline start-up and updates. **Bump `VERSION` on every release.** |
| `manifest.webmanifest`, `icons/` | Install as an app |
| `vendor/maplibre-gl/` | MapLibre GL JS 6.11.2, served locally so the app starts offline |
| `samples/sample-loop.gpx` | Synthetic 7.3 km loop for testing |
| `legacy/` | The original "Scan for Trails" prototype, kept for reference only |

No build step: the files are served exactly as they are.

## Run locally

```sh
python3 -m http.server 8000     # then open http://localhost:8000
npm test                        # geometry unit tests (Node 20+)
```

Developer switches (add to the address):

- `?sim`: pressing Start replays the loaded track in about 4 minutes, with one 120 m detour, so you can see the off-track alert without walking.
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
2. **Track.** Settings › Load sample track (or Open GPX › pick a file from Files).
   *Expect:* a blue loop, with the track name and length in the top bar. Quit the app from the app switcher and reopen it: the track is still there.
3. **Simulation.** Open the site with `?sim` added in Safari (a browser tab is fine for this), load the sample track, press Start.
   *Expect:* Done goes up and Remaining goes down. After about 1.5 minutes a red OFF TRACK banner appears with a beep, then "Back on track".
4. **Sound check.** Settings › turn Sound off and on: it beeps right away. Try it with the side ring/silent switch on and off, and note whether you hear it.
5. **Real GPS.** Outdoors, from the Home Screen app: Settings › Test loop here, press Start, allow location.
   *Expect:* a blue dot with a pale accuracy circle and "GPS ±5–15 m". Walk the loop; Done increases.
   Walk about 60 m away from the line: within a few seconds you get the banner and a beep. Come back: it clears.
6. **Wake Lock.** While hiking, the top bar shows **Screen awake**. Leave the phone untouched for 2 minutes.
   *Expect:* after 1 minute the screen goes black with large dim numbers (auto-dim), but the phone does **not** lock.
7. **Background.** Press Start, switch to another app for 1 minute, come back.
   *Expect:* "Screen awake" again, and GPS updates resume (the status may briefly say "no fix for N s"). GPS does **not** run while the app is in the background: this is an iOS limit.
8. **Offline.** Open the app once with signal, then switch on Airplane Mode and reopen it from the Home Screen.
   *Expect:* the app opens, with your track and live position. The map background may be blank: offline map tiles are not built yet.
9. **Update.** After a new version is published, open the app with signal.
   *Expect:* a "New version installed — Reload" banner. Settings › App version shows the new number.

### If Wake Lock fails

The top bar says **Screen may lock — tap to retry**, or the phone locks during step 6:

- Tap that message once (some iOS versions only grant Wake Lock right after a tap).
- Check Settings › This device › Screen wake lock. "Not supported" means your iOS is too old: update iOS (Wake Lock in Home Screen apps was reportedly unreliable before iOS 18.4).
- Turn off Low Power Mode: it can override Wake Lock.
- Fallback: iPhone Settings › Display & Brightness › Auto-Lock › **Never** for the hike (and set it back afterwards).
- Note which iOS version you have and what the status said: that tells us whether a workaround is needed.
