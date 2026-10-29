# Trails routing relay

A tiny Cloudflare Worker (a small program that runs on Cloudflare's servers) that
holds **your** openrouteservice key and asks openrouteservice for a hiking route
whenever the Trails planner needs one. Nobody using the app needs a key or any setup,
and the key never appears in the app or in this repo.

openrouteservice's FAQ asks for exactly this: a key belongs to one person and must not
be used inside an app; route the app's requests through your own server instead
(giscience.github.io/openrouteservice/frequently-asked-questions.html).

## What it allows

- Only `POST /route` with two nearby points (at most ≈50 km apart), as the planner sends.
- Only from the sites in `ALLOWED_ORIGINS` (`wrangler.toml`): the app on
  rinociardo.github.io, and `localhost:8000` for testing on the computer.
- At most 30 routes a minute per visitor (per IP address, counted per Cloudflare location).
- Your key's limits apply to everyone together: 2,000 routes a day, 40 a minute. When
  they are reached the planner draws segments straight with a short note.

Limits of the protection: other websites can't use it, but a script can pretend to be
the app. The rate limit and openrouteservice's daily quota cap the damage: the worst
case is that the day's 2,000 routes run out. Repeatedly going over the limit can get
the key blocked for a while by openrouteservice.

Cost: Cloudflare Workers' free plan (100,000 requests a day) is far more than needed.

## Setup (you do this once)

You need Node.js (already installed: `npm test` uses it). Wrangler is Cloudflare's
command-line tool; `npx` downloads the pinned version (4.151.0) the first time.

1. **Cloudflare account.** Sign up at https://dash.cloudflare.com/sign-up (free). Then
   open **Workers & Pages** in the dashboard once: it asks you to choose a
   `workers.dev` subdomain (e.g. `rinociardo`). Your relay's address will be
   `https://trails-relay.<subdomain>.workers.dev`.
2. **openrouteservice key.** If you haven't got one: sign up at
   https://account.heigit.org, then create a key (Standard, free). Copy it.
3. **Log Wrangler in** (opens the browser to allow access):
   ```
   cd ~/Projects/Trails/relay
   npx wrangler@4.151.0 login
   ```
4. **Deploy the relay:**
   ```
   npx wrangler@4.151.0 deploy
   ```
   It prints the address, e.g. `https://trails-relay.rinociardo.workers.dev`.
   If it refuses the `[[ratelimits]]` section, tell me the message (don't remove it on
   your own: it's the per-visitor limit).
5. **Store the key as a secret** (paste it when asked; it is stored encrypted at
   Cloudflare, never in a file):
   ```
   npx wrangler@4.151.0 secret put ORS_KEY
   ```
   Paste with **Ctrl+Shift+V** (or right-click › Paste): in a Linux terminal, Ctrl+V types
   an invisible control character instead. Nothing shows while you paste; that's normal.
6. **Check it works** (should print a long answer starting `{"type":"FeatureCollection"`):
   ```
   curl -s -X POST https://trails-relay.<subdomain>.workers.dev/route \
     -H 'Origin: https://rinociardo.github.io' -H 'Content-Type: application/json' \
     -d '{"coordinates":[[7.9067,46.5935],[7.9150,46.5990]]}' | head -c 200
   ```
   Without the `Origin` line it answers `{"error":"origin not allowed: …","from":"relay"}`: that is correct.
7. **Send me the address.** I put it in `map-config.js` (`ROUTER.relayUrl`), test the
   planner against it, and push the app only after your OK.

## When something goes wrong

Every error answer has a body: `{"error": …, "from": "relay"}` for the relay's own refusals
(with a short reason), or `{"error": {"code": …, "message": …}, "from": "openrouteservice"}`
with openrouteservice's own message passed on. Add `-i` to the curl test to see the status.

To watch the relay live, run this in a second terminal, then repeat the curl test:
```
cd ~/Projects/Trails/relay
npx wrangler@4.151.0 tail --format pretty
```
For every openrouteservice error it logs the status, content type, server and message,
plus facts about the key that don't reveal it (`length`, `surroundingSpace`,
`unusualCharacters`). The key itself is never logged or sent back: if an answer ever
quotes it, it is replaced by `[key]`.

## Later

- Change allowed sites or the rate limit: edit `wrangler.toml`, then `deploy` again.
- New key: `secret put ORS_KEY` again (no deploy needed).
- See requests and errors: dashboard › Workers & Pages › trails-relay › Logs.
- Stop it completely: `npx wrangler@4.151.0 delete` (the planner then draws straight).
- Tests (no network, no key): `npm test` in the repo includes `tests/relay.test.js`.
