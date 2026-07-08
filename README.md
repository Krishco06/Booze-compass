# Booze Compass 🧭🍾

A free PWA that finds the nearest spot in a chosen category and points a compass
arrow straight at it. No API keys, no billing accounts, no Apple Developer Program.

- **Modes:** six selectable categories, each with its own OSM tag filters and
  tuned search radius — Liquor (6 km), Bars (5 km), Dispensary (40 km),
  Casino (80 km), Fast Food (4 km), Smokes (8 km). Sparse categories get a
  wider net; a mode is one config entry in `MODES`.
- **Data:** OpenStreetMap via the Overpass API (per-mode tag filters, e.g.
  `shop=alcohol|wine|beverages`, `amenity=bar|pub`, `shop=cannabis`)
- **Map:** MapLibre GL JS; dark basemap by default (CARTO dark_all raster tiles, keyless) with a toggle to OSM standard light tiles (attribution included)
- **Compass:** `webkitCompassHeading` on iOS (button-tap permission required), `deviceorientationabsolute` on Android
- **No build step:** plain HTML/CSS/JS static files

## Run locally

```
python -m http.server 8734 -d .
```

Open http://localhost:8734. Without location permission it falls back to a demo
location (Cicero, IL) so you can still see it work on desktop.

## Deploy free (GitHub Pages)

1. Create a **public** repo on GitHub (e.g. `booze-compass`).
2. Push this folder's contents to the `main` branch:
   ```
   git init
   git add .
   git commit -m "Booze Compass PWA"
   git remote add origin https://github.com/<you>/booze-compass.git
   git push -u origin main
   ```
3. Repo → **Settings → Pages** → Source: *Deploy from a branch*, Branch: `main`, folder `/ (root)`.
4. Your app is live at `https://<you>.github.io/booze-compass/` (HTTPS, required for geolocation).

Cloudflare Pages / Netlify work the same way — drag-and-drop the folder or connect the repo.

## Install on iPhone

1. Open the URL in **Safari**.
2. Share button → **Add to Home Screen**.
3. Launch from the home-screen icon (standalone, no browser chrome).
4. Grant location when prompted; on the Compass tab, tap **Enable compass**
   (iOS requires a tap to grant device-orientation access, once per session).

## Notes / limits

- iOS compass via the web is the known weak point — it can drift and needs
  the button-tap permission each session. If it's too flaky, the fallback plan
  is a native Expo app sideloaded via SideStore.
- Each mode has a tuned base radius; a manual range picker (×0.5/×1/×2/×4,
  shown in miles) scales it and resets to the mode default on switch.
  "Expand search" steps up to the next range when a mode is empty.
- Overpass mirrors are **raced in parallel** (first healthy one wins, the rest
  abort) with a few retry rounds — a slow/504'ing primary no longer stalls the
  search. Results are cached in memory (5 min) and localStorage (30 min) per
  mode + radius + ~1 km cell, so relaunching is instant. Fetches fire only on
  first load, mode change, range/expand, and significant moves.
- Dense modes can return hundreds of hits; the map caps pins to the nearest 75
  (kept smooth), while the full list still feeds distance sorting and the compass.
- OSM coverage of liquor stores is imperfect; stores tagged only as generic
  convenience stores without `alcohol=yes` won't appear.
- Map tiles come from `tile.openstreetmap.org` under its usage policy
  (attribution shown, referrer policy set, no tile prefetching in the
  service worker).
