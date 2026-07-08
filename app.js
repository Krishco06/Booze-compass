/* Booze Compass — nearest "thing" finder PWA
 * Data: OpenStreetMap via Overpass API (no key). Map: MapLibre + OSM/CARTO raster tiles.
 */
"use strict";

// Demo fallback (Cicero, IL) used when geolocation is denied/unavailable,
// so the app is still testable on desktop.
const FALLBACK = { lat: 41.8456, lon: -87.7539 };
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const MEM_TTL_MS = 5 * 60 * 1000; // in-memory result cache

/* Single source of truth for all modes. Each mode carries its own OSM tag
 * filters and its own search radius (metres) — sparse categories get a wider
 * net, dense ones stay tight so "nearest" is genuinely near. Adding a 7th
 * mode is a one-line config addition; the UI maps over this array.
 *
 * Coverage notes (so misses aren't surprises):
 *  - dispensary (shop=cannabis): recreational is legal in IL but OSM coverage
 *    is thin/inconsistent; 40 km radius compensates, Expand search is the fallback.
 *  - bar (amenity=bar|pub): pub vs bar is tagged fairly arbitrarily, so both.
 *  - casino (amenity=casino): catches real casinos, NOT the video-gambling
 *    terminals in IL bars/gas stations (inconsistently tagged — would pollute).
 *  - smokes (shop=tobacco|e-cigarette): most cigs are actually sold at gas/
 *    convenience stores, deliberately excluded to avoid drowning in 7-Elevens.
 *  - fast food (amenity=fast_food): dense & well-mapped; tight 4 km on purpose.
 */
const MODES = [
  { id: "liquor", label: "Liquor", emoji: "🍾", radius: 6000,
    filters: [["shop", "alcohol"], ["shop", "wine"], ["shop", "beverages"]] },

  { id: "bar", label: "Bars", emoji: "🍺", radius: 5000,
    filters: [["amenity", "bar"], ["amenity", "pub"]] },

  { id: "dispensary", label: "Dispensary", emoji: "🌿", radius: 40000, // sparse
    filters: [["shop", "cannabis"]] },

  { id: "casino", label: "Casino", emoji: "🎰", radius: 80000, // very sparse
    filters: [["amenity", "casino"], ["leisure", "adult_gaming_centre"]] },

  { id: "fastfood", label: "Fast Food", emoji: "🍔", radius: 4000, // dense, keep tight
    filters: [["amenity", "fast_food"]] },

  { id: "cigarettes", label: "Smokes", emoji: "🚬", radius: 8000,
    filters: [["shop", "tobacco"], ["shop", "e-cigarette"]] },
];

const state = {
  pos: null,          // {lat, lon}
  mode: MODES.find((m) => m.id === localStorage.getItem("mode")) || MODES[0],
  expandMult: 1,      // transient radius multiplier from "Expand search" (resets on mode change)
  searchToken: 0,     // guards against out-of-order responses when switching fast
  searchPos: null,    // where the last search ran, for significant-move refetch
  dark: localStorage.getItem("mapTheme") !== "light",
  usingFallback: false,
  stores: [],         // sorted by distance
  target: null,       // place the compass points at
  heading: null,      // degrees clockwise from north
  map: null,
  meMarker: null,
  storeMarkers: [],
  fetched: false,
};

const memCache = new Map(); // key -> { t, places }

const $ = (id) => document.getElementById(id);

/* ---------------- geometry ---------------- */
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

// Initial great-circle bearing from a to b, degrees 0-360.
function bearing(a, b) {
  const φ1 = toRad(a.lat), φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const θ = Math.atan2(
    Math.sin(Δλ) * Math.cos(φ2),
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  );
  return (toDeg(θ) + 360) % 360;
}

function fmtDist(m) {
  const mi = m / 1609.344;
  if (mi < 0.19) return `${Math.round(m * 3.28084)} ft`;
  return `${mi.toFixed(mi < 10 ? 1 : 0)} mi`;
}

/* ---------------- banner ---------------- */
let bannerTimer = null;
function banner(msg, sticky = false) {
  const el = $("banner");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(bannerTimer);
  if (!sticky) bannerTimer = setTimeout(() => el.classList.add("hidden"), 5000);
}

/* ---------------- Overpass ---------------- */
// One nwr[...] clause per filter, all within the mode's radius.
// `out center;` makes ways/relations return a single center lat/lon.
function buildQuery(mode, lat, lon, radius) {
  const clauses = mode.filters
    .map(([k, v]) => `  nwr["${k}"="${v}"](around:${radius},${lat.toFixed(5)},${lon.toFixed(5)});`)
    .join("\n");
  return `[out:json][timeout:25];\n(\n${clauses}\n);\nout center;`;
}

// Nodes carry lat/lon directly; ways/relations carry a `center`.
function coordsOf(el) {
  const p = el.type === "node" ? el : el.center;
  return p && p.lat != null && p.lon != null ? { lat: p.lat, lon: p.lon } : null;
}

async function fetchPlaces(mode, lat, lon, radius) {
  // in-memory cache keyed on mode + radius + ~1km grid cell, short TTL,
  // so toggling back to a just-searched mode doesn't refetch (Overpass policy)
  const key = `${mode.id}:${radius}:${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = memCache.get(key);
  if (hit && Date.now() - hit.t < MEM_TTL_MS) return hit.places;

  const body = "data=" + encodeURIComponent(buildQuery(mode, lat, lon, radius));
  let lastErr;
  // two rounds over the endpoints; abort any request that hangs
  for (const endpoint of [...OVERPASS_ENDPOINTS, ...OVERPASS_ENDPOINTS]) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const places = (json.elements || [])
        .map((el) => {
          const c = coordsOf(el);
          if (!c) return null;
          const tags = el.tags || {};
          return {
            id: `${el.type}/${el.id}`,
            lat: c.lat,
            lon: c.lon,
            name: tags.name || mode.label,
            addr: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
          };
        })
        .filter(Boolean);
      // dedupe: same place can appear under multiple tags/types — drop repeats
      // by OSM id and by rounded coordinate
      const seenId = new Set();
      const seenCoord = new Set();
      const unique = places.filter((p) => {
        const ck = `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
        if (seenId.has(p.id) || seenCoord.has(ck)) return false;
        seenId.add(p.id);
        seenCoord.add(ck);
        return true;
      });
      memCache.set(key, { t: Date.now(), places: unique });
      return unique;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/* ---------------- map ---------------- */
// Dark basemap: CARTO's keyless OSM-based raster tiles. Light: OSM standard tiles.
function mapStyle(dark) {
  const source = dark
    ? {
        tiles: ["a", "b", "c", "d"].map(
          (s) => `https://${s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png`
        ),
        attribution:
          "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors © <a href='https://carto.com/attributions'>CARTO</a>",
      }
    : {
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        attribution: "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",
      };
  return {
    version: 8,
    sources: { base: { type: "raster", tileSize: 256, maxzoom: 19, ...source } },
    layers: [{ id: "base", type: "raster", source: "base" }],
  };
}

function initMap() {
  state.map = new maplibregl.Map({
    container: "map",
    center: [state.pos.lon, state.pos.lat],
    zoom: 13,
    attributionControl: { compact: true },
    style: mapStyle(state.dark),
  });

  const meEl = document.createElement("div");
  meEl.className = "marker-me";
  state.meMarker = new maplibregl.Marker({ element: meEl })
    .setLngLat([state.pos.lon, state.pos.lat])
    .addTo(state.map);
}

function renderStores() {
  state.storeMarkers.forEach((m) => m.remove());
  state.storeMarkers = [];

  state.stores.forEach((s, i) => {
    const el = document.createElement("div");
    el.className = "marker-store" + (i === 0 ? " nearest" : "");
    el.innerHTML = `<span>${state.mode.emoji}</span>`;
    s._el = el;
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      selectStore(s);
    });
    const m = new maplibregl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([s.lon, s.lat])
      .addTo(state.map);
    state.storeMarkers.push(m);
  });

  if (state.stores.length) {
    // frame user + nearest few stores
    const b = new maplibregl.LngLatBounds();
    b.extend([state.pos.lon, state.pos.lat]);
    state.stores.slice(0, 3).forEach((s) => b.extend([s.lon, s.lat]));
    state.map.fitBounds(b, { padding: 70, maxZoom: 15 });
  }
}

function selectStore(s) {
  state.target = s;
  state.stores.forEach((x) => x._el && x._el.classList.toggle("selected", x === s));
  $("info-name").textContent = s.name;
  const d = haversineMeters(state.pos, s);
  $("info-meta").textContent = [fmtDist(d) + " away", s.addr, state.mode.label].filter(Boolean).join(" · ");
  $("store-info").classList.remove("hidden");
  updateCompassUI();
}

/* ---------------- location ---------------- */
function onPosition(lat, lon) {
  const first = !state.pos;
  state.pos = { lat, lon };
  if (first) {
    initMap();
    runSearch();
  } else {
    if (state.meMarker) state.meMarker.setLngLat([lon, lat]);
    // only refetch on a significant move, not on every GPS jitter
    if (state.searchPos && haversineMeters(state.searchPos, { lat, lon }) > 1000) {
      runSearch();
    }
  }
  updateCompassUI();
}

/* Mode-aware search: fetch → dedupe → distance-sort → render both tabs.
 * Fires only on first load, mode change, Expand search, and significant moves. */
async function runSearch() {
  if (!state.pos) return;
  const mode = state.mode;
  const radius = mode.radius * state.expandMult;
  const token = ++state.searchToken;
  state.searchPos = { lat: state.pos.lat, lon: state.pos.lon };
  banner(`Finding nearest ${mode.label}…`, true);
  try {
    const places = await fetchPlaces(mode, state.pos.lat, state.pos.lon, radius);
    if (token !== state.searchToken) return; // a newer search superseded this one
    places.forEach((p) => (p.dist = haversineMeters(state.pos, p)));
    places.sort((a, b) => a.dist - b.dist);
    state.stores = places;
    state.fetched = true;
    if (!places.length) {
      handleEmpty(mode, radius);
      return;
    }
    hideEmpty();
    banner(`Found ${places.length} nearby`);
    renderStores();
    selectStore(places[0]); // nearest becomes the compass target
  } catch (e) {
    if (token !== state.searchToken) return;
    banner("Couldn't reach the map database (Overpass). Try again.", true);
    console.error(e);
  }
}

function fmtKm(m) {
  const km = m / 1000;
  return km >= 10 ? `${Math.round(km)} km` : `${km.toFixed(1)} km`;
}

// Empty results: message on both tabs, compass arrow hidden, map on the user,
// plus an "Expand search" button that doubles the radius for the next try.
function handleEmpty(mode, radius) {
  state.stores = [];
  state.target = null;
  renderStores(); // clears markers
  const msg = `No ${mode.label.toLowerCase()} found within ${fmtKm(radius)}`;
  banner(msg, true);
  $("store-info").classList.add("hidden");
  $("empty-map-text").textContent = msg;
  $("empty-map").classList.remove("hidden");
  document.querySelector(".compass-wrap").classList.add("empty");
  $("compass-store").textContent = msg;
  $("compass-dist").textContent = "";
  $("compass-sub").textContent = "";
  $("btn-expand").classList.remove("hidden");
  if (state.map) state.map.flyTo({ center: [state.pos.lon, state.pos.lat], zoom: 12 });
}

function hideEmpty() {
  $("empty-map").classList.add("hidden");
  document.querySelector(".compass-wrap").classList.remove("empty");
  $("btn-expand").classList.add("hidden");
}

function expandSearch() {
  state.expandMult *= 2; // transient — never mutates the mode config
  runSearch();
}

function startGeolocation() {
  if (!("geolocation" in navigator)) {
    useFallback("Geolocation not supported");
    return;
  }
  navigator.geolocation.watchPosition(
    (p) => onPosition(p.coords.latitude, p.coords.longitude),
    (err) => {
      if (!state.pos) useFallback(err.message);
    },
    { enableHighAccuracy: true, maximumAge: 10000, timeout: 15000 }
  );
}

function useFallback(reason) {
  state.usingFallback = true;
  banner("Location unavailable — using demo location (Cicero, IL)", true);
  console.warn("Geolocation failed:", reason);
  onPosition(FALLBACK.lat, FALLBACK.lon);
}

/* ---------------- compass ---------------- */
function onHeading(h) {
  state.heading = h;
  updateCompassUI();
}

/* The arrow is animated per-frame toward its target along the shortest arc.
 * Two problems this solves vs. setting the rotation directly:
 *  - crossing 0°/360° no longer spins the arrow the long way around
 *  - jittery heading readings get low-pass filtered into smooth motion */
let arrowTarget = 0;
let arrowCurrent = null;
function setArrowTarget(deg) {
  arrowTarget = ((deg % 360) + 360) % 360;
}
function stepArrow() {
  if (arrowCurrent === null) arrowCurrent = arrowTarget;
  const cur = ((arrowCurrent % 360) + 360) % 360;
  const delta = ((arrowTarget - cur + 540) % 360) - 180; // shortest signed arc
  arrowCurrent += Math.abs(delta) < 0.1 ? delta : delta * 0.15;
  $("arrow").style.transform = `rotate(${arrowCurrent.toFixed(2)}deg)`;
}
function animateArrow() {
  stepArrow();
  requestAnimationFrame(animateArrow);
}

let lastSubUpdate = 0;
function updateCompassUI() {
  const t = state.target;
  if (!t || !state.pos) return;
  const d = haversineMeters(state.pos, t);
  const brg = bearing(state.pos, t);
  $("compass-store").textContent = t.name;
  $("compass-dist").textContent = fmtDist(d);

  if (state.heading == null) {
    $("compass-sub").textContent = "Enable the compass to get a live arrow";
    setArrowTarget(brg); // static: bearing relative to north-up dial
  } else {
    setArrowTarget(brg - state.heading);
    // throttle the text so it doesn't flicker at sensor rate
    const now = Date.now();
    if (now - lastSubUpdate > 250) {
      lastSubUpdate = now;
      $("compass-sub").textContent = `Bearing ${Math.round(brg)}° · heading ${Math.round(state.heading)}°`;
    }
  }
}

function attachOrientationListeners() {
  // iOS: webkitCompassHeading (degrees clockwise from north).
  // Android: deviceorientationabsolute alpha (counterclockwise) -> 360 - alpha.
  window.addEventListener("deviceorientation", (e) => {
    if (typeof e.webkitCompassHeading === "number" && !isNaN(e.webkitCompassHeading)) {
      onHeading(e.webkitCompassHeading);
    }
  });
  window.addEventListener("deviceorientationabsolute", (e) => {
    if (e.absolute && e.alpha != null) onHeading((360 - e.alpha) % 360);
  });
}

function setupCompassPermission() {
  const btn = $("btn-compass");
  const needsPermission =
    typeof DeviceOrientationEvent !== "undefined" &&
    typeof DeviceOrientationEvent.requestPermission === "function";

  if (!needsPermission) {
    attachOrientationListeners();
    return;
  }

  // iOS 13+: requestPermission() must run inside a user gesture, but once the
  // user has granted it for this site it resolves "granted" with no prompt.
  // So we piggyback on ANY tap (tab switch, map, etc.) — after the first-ever
  // grant the compass enables itself silently on every launch and the button
  // never appears again.
  let enabled = false;
  const tryEnable = async (fromButton) => {
    if (enabled) return;
    try {
      const resp = await DeviceOrientationEvent.requestPermission();
      if (resp === "granted") {
        enabled = true;
        btn.classList.add("hidden");
        attachOrientationListeners();
        document.removeEventListener("click", silentTry, true);
      } else {
        // explicit denial: stop nagging on every tap, leave the button as the way back in
        document.removeEventListener("click", silentTry, true);
        if (fromButton) banner("Compass permission denied — arrow will stay north-up", true);
      }
    } catch (e) {
      // not triggerable from this gesture / unsupported; the button remains
      if (fromButton) {
        banner("Compass unavailable on this device");
        console.error(e);
      }
    }
  };
  const silentTry = () => tryEnable(false);

  btn.classList.remove("hidden");
  btn.addEventListener("click", () => tryEnable(true));
  document.addEventListener("click", silentTry, true);
}

/* ---------------- tabs & wiring ---------------- */
function setupTabs() {
  document.querySelectorAll(".tabbtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabbtn").forEach((b) => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === btn.dataset.tab));
      if (btn.dataset.tab === "tab-map" && state.map) state.map.resize();
    });
  });
  $("btn-point").addEventListener("click", () => {
    document.querySelector('[data-tab="tab-compass"]').click();
  });
}

// Render the mode selector from MODES (mapped, not hardcoded — a 7th mode
// just needs a config entry). Tapping a mode re-runs the search.
function renderModeBar() {
  const bar = $("mode-bar");
  bar.innerHTML = "";
  MODES.forEach((m) => {
    const btn = document.createElement("button");
    btn.className = "mode-btn" + (m.id === state.mode.id ? " active" : "");
    btn.innerHTML = `<span class="mb-emoji">${m.emoji}</span><span>${m.label}</span>`;
    btn.addEventListener("click", () => {
      if (m.id === state.mode.id) return;
      state.mode = m;
      state.expandMult = 1; // fresh mode starts at its own radius
      localStorage.setItem("mode", m.id);
      renderModeBar();
      if (state.pos) runSearch();
    });
    bar.appendChild(btn);
  });
}

function setupMapControls() {
  $("btn-expand").addEventListener("click", expandSearch);
  $("btn-expand-map").addEventListener("click", expandSearch);
  $("btn-recenter").addEventListener("click", () => {
    if (state.map && state.pos) {
      state.map.flyTo({ center: [state.pos.lon, state.pos.lat], zoom: 14 });
    }
  });
  const themeBtn = $("btn-theme");
  const applyThemeIcon = () => (themeBtn.textContent = state.dark ? "☀️" : "🌙");
  applyThemeIcon();
  themeBtn.addEventListener("click", () => {
    state.dark = !state.dark;
    localStorage.setItem("mapTheme", state.dark ? "dark" : "light");
    applyThemeIcon();
    if (state.map) state.map.setStyle(mapStyle(state.dark)); // DOM markers survive setStyle
  });
}

function main() {
  setupTabs();
  renderModeBar();
  setupMapControls();
  animateArrow();
  setupCompassPermission();
  startGeolocation();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

main();
