/* Booze Compass — nearest liquor store PWA
 * Data: OpenStreetMap via Overpass API (no key). Map: MapLibre + OSM raster tiles.
 */
"use strict";

// Demo fallback (Cicero, IL) used when geolocation is denied/unavailable,
// so the app is still testable on desktop.
const FALLBACK = { lat: 41.8456, lon: -87.7539 };
const DEFAULT_RADIUS_M = 8047; // 5 mi
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const CACHE_TTL_MS = 15 * 60 * 1000;

const state = {
  pos: null,          // {lat, lon}
  radius: parseInt(localStorage.getItem("radius"), 10) || DEFAULT_RADIUS_M,
  usingFallback: false,
  stores: [],         // sorted by distance
  target: null,       // store the compass points at
  heading: null,      // degrees clockwise from north
  map: null,
  meMarker: null,
  storeMarkers: [],
  fetched: false,
};

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
function overpassQuery(lat, lon) {
  const around = `(around:${state.radius},${lat.toFixed(5)},${lon.toFixed(5)})`;
  return `[out:json][timeout:25];
(
  nwr["shop"="alcohol"]${around};
  nwr["shop"="wine"]${around};
  nwr["shop"="beverages"]${around};
  nwr["shop"="convenience"]["alcohol"="yes"]${around};
);
out center;`;
}

async function fetchStores(lat, lon) {
  // cache by ~1km grid cell to respect Overpass usage policy
  const key = `stores:${state.radius}:${lat.toFixed(2)},${lon.toFixed(2)}`;
  try {
    const cached = JSON.parse(localStorage.getItem(key));
    if (cached && Date.now() - cached.t < CACHE_TTL_MS) return cached.stores;
  } catch { /* ignore bad cache */ }

  const body = "data=" + encodeURIComponent(overpassQuery(lat, lon));
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
      const stores = (json.elements || [])
        .map((el) => {
          const p = el.center || el;
          if (p.lat == null || p.lon == null) return null;
          const tags = el.tags || {};
          return {
            id: `${el.type}/${el.id}`,
            lat: p.lat,
            lon: p.lon,
            name: tags.name || labelFor(tags.shop),
            shop: tags.shop || "?",
            addr: [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" "),
          };
        })
        .filter(Boolean);
      // de-dup by id (a store can match multiple tag queries)
      const seen = new Set();
      const unique = stores.filter((s) => !seen.has(s.id) && seen.add(s.id));
      try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), stores: unique })); } catch {}
      return unique;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function labelFor(shop) {
  return { alcohol: "Liquor store", wine: "Wine shop", beverages: "Beverage shop", convenience: "Convenience store" }[shop] || "Store";
}

/* ---------------- map ---------------- */
function initMap() {
  state.map = new maplibregl.Map({
    container: "map",
    center: [state.pos.lon, state.pos.lat],
    zoom: 13,
    attributionControl: { compact: true },
    style: {
      version: 8,
      sources: {
        osm: {
          type: "raster",
          tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
          tileSize: 256,
          maxzoom: 19,
          attribution: "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> contributors",
        },
      },
      layers: [{ id: "osm", type: "raster", source: "osm" }],
    },
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
    el.innerHTML = "<span>🍾</span>";
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
  $("info-name").textContent = s.name;
  const d = haversineMeters(state.pos, s);
  $("info-meta").textContent = [fmtDist(d) + " away", s.addr, labelFor(s.shop)].filter(Boolean).join(" · ");
  $("store-info").classList.remove("hidden");
  updateCompassUI();
}

/* ---------------- location ---------------- */
function onPosition(lat, lon) {
  const first = !state.pos;
  state.pos = { lat, lon };
  if (first) {
    initMap();
    loadStores();
  } else if (state.meMarker) {
    state.meMarker.setLngLat([lon, lat]);
  }
  updateCompassUI();
}

async function loadStores() {
  banner("Searching for liquor stores nearby…", true);
  try {
    const stores = await fetchStores(state.pos.lat, state.pos.lon);
    stores.forEach((s) => (s.dist = haversineMeters(state.pos, s)));
    stores.sort((a, b) => a.dist - b.dist);
    state.stores = stores;
    state.fetched = true;
    if (!stores.length) {
      const mi = Math.round(state.radius / 1609.344);
      banner(`No liquor stores found within ${mi} miles 😢 — try a bigger range`, true);
      $("compass-store").textContent = "No stores found nearby";
      $("store-info").classList.add("hidden");
      return;
    }
    banner(`Found ${stores.length} store${stores.length > 1 ? "s" : ""} nearby`);
    renderStores();
    selectStore(stores[0]); // nearest
  } catch (e) {
    banner("Couldn't reach the store database (Overpass). Try again later.", true);
    console.error(e);
  }
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

  if (needsPermission) {
    // iOS 13+: must be requested from a user gesture
    btn.classList.remove("hidden");
    btn.addEventListener("click", async () => {
      try {
        const resp = await DeviceOrientationEvent.requestPermission();
        if (resp === "granted") {
          btn.classList.add("hidden");
          attachOrientationListeners();
        } else {
          banner("Compass permission denied — arrow will stay north-up", true);
        }
      } catch (e) {
        banner("Compass unavailable on this device");
        console.error(e);
      }
    });
  } else {
    attachOrientationListeners();
    // if no orientation event fires shortly, we just keep the north-up arrow
  }
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

function setupMapControls() {
  const bar = $("radius-bar");
  bar.querySelectorAll(".chip").forEach((c) => {
    c.classList.toggle("active", parseInt(c.dataset.r, 10) === state.radius);
    c.addEventListener("click", () => {
      const r = parseInt(c.dataset.r, 10);
      if (r === state.radius) return;
      state.radius = r;
      localStorage.setItem("radius", String(r));
      bar.querySelectorAll(".chip").forEach((b) => b.classList.toggle("active", b === c));
      if (state.pos) loadStores();
    });
  });
  $("btn-recenter").addEventListener("click", () => {
    if (state.map && state.pos) {
      state.map.flyTo({ center: [state.pos.lon, state.pos.lat], zoom: 14 });
    }
  });
}

function main() {
  setupTabs();
  setupMapControls();
  animateArrow();
  setupCompassPermission();
  startGeolocation();
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}

main();
