# Booze Compass 🧭🍾

A free PWA that finds the nearest liquor store and points a compass arrow straight at it.
No API keys, no billing accounts, no Apple Developer Program.

- **Data:** OpenStreetMap via the Overpass API (`shop=alcohol|wine|beverages` + `shop=convenience` with `alcohol=yes`)
- **Map:** MapLibre GL JS + OSM raster tiles (attribution included)
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
- Overpass results are cached in `localStorage` for 15 minutes per ~1 km grid
  cell; requests time out after 30 s and fall back to a mirror.
- OSM coverage of liquor stores is imperfect; stores tagged only as generic
  convenience stores without `alcohol=yes` won't appear.
- Map tiles come from `tile.openstreetmap.org` under its usage policy
  (attribution shown, referrer policy set, no tile prefetching in the
  service worker).
