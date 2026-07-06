/*
  Boot Routeplanner v18
  - Leeg netwerk: geen snelheidszones, geen gebiedslagen, geen standaard routes, geen standaard bruggen.
  - Gebruiker tekent zelf vaarroutes en bruggen/sluizen/doorvaarten.
  - Routeplanner gebruikt alleen het eigen netwerk en blokkeert bruggen op bootmaat.
*/

const canvas = document.getElementById('map');
const ctx = canvas.getContext('2d');
const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'bootRouteEditor.customNetwork.v14';
const BOAT_KEY = 'bootRouteEditor.boatProfile.v14';
const TILE_SIZE = 256;
const MAP_LAYER_KEY = 'bootRouteEditor.mapLayer.v18';
const OFFLINE_MAP_URL = './data/offline_nederland_simple.geojson';
const MIN_ZOOM = 10;
const MAX_ZOOM = 19;
const NL_BOUNDS = { minLon: 3.05, minLat: 50.72, maxLon: 7.35, maxLat: 53.65 };
const GPS_STALE_MS = 12000;
const JOIN_TOLERANCE_M = 18;
const SNAP_MAX_M = 500;
const BRIDGE_DEFAULT_RADIUS_M = 25;

const state = {
  center: { lat: 52.1967, lon: 5.0697 },
  zoom: 13,
  follow: true,
  user: null,
  lastFix: null,
  lastGpsReceivedAt: null,
  speedKmh: null,
  tileCache: new Map(),
  mapLayerMode: localStorage.getItem(MAP_LAYER_KEY) || 'auto',
  offlineSimpleMap: null,
  dragging: false,
  pointerMoved: false,
  dragStart: null,
  centerStart: null,
  gpsWatchId: null,
  dpr: 1,
  size: { w: 0, h: 0 },

  customNetwork: emptyNetwork(),
  hardcodedNetwork: emptyNetwork(),
  usesBrowserData: false,
  routeGraph: null,

  routeStart: null,
  routeEnd: null,
  routePickMode: null,
  plannedRoute: [],
  routeNotices: [],
  boatProfile: { heightM: null, widthM: null, draftM: null, marginM: 0.20, blockUnknownPassages: false },

  editorOpen: false,
  editorMode: 'select',
  routeDraft: [],
  selectedRouteId: null,
  selectedBridgeId: null,
  bridgePickMode: false
};

function emptyNetwork() {
  return { type: 'FeatureCollection', name: 'custom_navigation_network', version: 1, features: [] };
}

function uid(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function resize() {
  state.dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  state.size.w = window.innerWidth;
  state.size.h = window.innerHeight;
  canvas.width = Math.round(state.size.w * state.dpr);
  canvas.height = Math.round(state.size.h * state.dpr);
  canvas.style.width = `${state.size.w}px`;
  canvas.style.height = `${state.size.h}px`;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  draw();
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function clampCenter(center) {
  return { lat: clamp(center.lat, NL_BOUNDS.minLat, NL_BOUNDS.maxLat), lon: clamp(center.lon, NL_BOUNDS.minLon, NL_BOUNDS.maxLon) };
}

function lonLatToWorld(lon, lat, zoom) {
  const sinLat = Math.sin(lat * Math.PI / 180);
  const n = 2 ** zoom;
  const x = (lon + 180) / 360 * n * TILE_SIZE;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * n * TILE_SIZE;
  return { x, y };
}

function worldToLonLat(x, y, zoom) {
  const n = 2 ** zoom;
  const lon = x / (n * TILE_SIZE) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (n * TILE_SIZE))));
  return { lon, lat: latRad * 180 / Math.PI };
}

function project(lon, lat) {
  const c = lonLatToWorld(state.center.lon, state.center.lat, state.zoom);
  const p = lonLatToWorld(lon, lat, state.zoom);
  return { x: state.size.w / 2 + (p.x - c.x), y: state.size.h / 2 + (p.y - c.y) };
}

function unproject(x, y) {
  const c = lonLatToWorld(state.center.lon, state.center.lat, state.zoom);
  const wx = c.x + (x - state.size.w / 2);
  const wy = c.y + (y - state.size.h / 2);
  return worldToLonLat(wx, wy, state.zoom);
}

function metersPerDegLon(lat) { return 111320 * Math.cos(lat * Math.PI / 180); }
function haversine(a, b) {
  const R = 6371000;
  const p1 = a.lat * Math.PI / 180;
  const p2 = b.lat * Math.PI / 180;
  const dp = (b.lat - a.lat) * Math.PI / 180;
  const dl = (b.lon - a.lon) * Math.PI / 180;
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

function lonLatToMeters(point, refLat) {
  return { x: point.lon * metersPerDegLon(refLat), y: point.lat * 111320 };
}

function closestPointOnSegment(p, a, b) {
  const refLat = (p.lat + a.lat + b.lat) / 3;
  const pm = lonLatToMeters(p, refLat);
  const am = lonLatToMeters(a, refLat);
  const bm = lonLatToMeters(b, refLat);
  const vx = bm.x - am.x;
  const vy = bm.y - am.y;
  const len2 = vx * vx + vy * vy;
  let t = 0;
  if (len2 > 0) t = clamp(((pm.x - am.x) * vx + (pm.y - am.y) * vy) / len2, 0, 1);
  const x = am.x + vx * t;
  const y = am.y + vy * t;
  const lon = x / metersPerDegLon(refLat);
  const lat = y / 111320;
  return { point: { lon, lat }, t, distanceM: haversine(p, { lon, lat }) };
}

function pointToSegmentDistanceM(p, a, b) { return closestPointOnSegment(p, a, b).distanceM; }

function formatCoord(p) {
  if (!p) return 'Nog niet gekozen';
  return `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
}

function parseNum(value) {
  const s = String(value ?? '').trim().replace(',', '.');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function setStatus(label, text, cls = 'neutral') {
  $('statusLabel').textContent = label;
  $('statusLabel').className = `statusLabel ${cls}`;
  $('status').textContent = text;
}

function setEditorStatus(text) { $('editorStatus').textContent = text; }
function setRouteStatus(text) { $('routeStatus').textContent = text; }

function getTileUrl(z, x, y) {
  return `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
}

function effectiveMapLayer() {
  if (state.mapLayerMode === 'simple') return 'simple';
  if (state.mapLayerMode === 'online') return 'online';
  return navigator.onLine ? 'online' : 'simple';
}

function mapLayerLabel() {
  const eff = effectiveMapLayer();
  if (state.mapLayerMode === 'auto') return `Kaartlaag: Auto (${eff === 'online' ? 'online' : 'vector'})`;
  return state.mapLayerMode === 'online' ? 'Kaartlaag: Online' : 'Kaartlaag: Vector offline';
}

function updateMapLayerUi() {
  const btn = $('mapLayerBtn');
  if (!btn) return;
  btn.textContent = mapLayerLabel();
  btn.classList.toggle('active', effectiveMapLayer() === 'simple');
  $('cacheMapBtn').disabled = effectiveMapLayer() !== 'online';
}

function cycleMapLayer() {
  const order = ['auto', 'online', 'simple'];
  const i = order.indexOf(state.mapLayerMode);
  state.mapLayerMode = order[(i + 1) % order.length];
  localStorage.setItem(MAP_LAYER_KEY, state.mapLayerMode);
  updateMapLayerUi();
  setStatus('Kaartlaag', state.mapLayerMode === 'simple'
    ? 'Vector offline kaart actief. Jouw routes blijven op dezelfde GPS-positie.'
    : state.mapLayerMode === 'online'
      ? 'Online detailkaart actief. Offline schakelt Auto terug naar de vectorkaart.'
      : 'Auto actief: online detailkaart met internet, vectorkaart zonder internet.', 'neutral');
  draw();
}

async function loadOfflineSimpleMap() {
  try {
    const res = await fetch(OFFLINE_MAP_URL, { cache: 'force-cache' });
    if (res.ok) state.offlineSimpleMap = await res.json();
  } catch (err) {
    console.warn('Simpele offline kaart niet geladen', err);
    state.offlineSimpleMap = null;
  }
}

function loadTile(z, x, y) {
  const n = 2 ** z;
  if (y < 0 || y >= n) return null;
  const wrappedX = ((x % n) + n) % n;
  const key = `osm:${z}/${wrappedX}/${y}`;
  if (state.tileCache.has(key)) return state.tileCache.get(key);
  const img = new Image();
  img.decoding = 'async';
  img.onload = draw;
  img.onerror = draw;
  img.src = getTileUrl(z, wrappedX, y);
  state.tileCache.set(key, img);
  return img;
}

function drawTiles() {
  const z = state.zoom;
  const centerWorld = lonLatToWorld(state.center.lon, state.center.lat, z);
  const topLeft = { x: centerWorld.x - state.size.w / 2, y: centerWorld.y - state.size.h / 2 };
  const startX = Math.floor(topLeft.x / TILE_SIZE) - 1;
  const startY = Math.floor(topLeft.y / TILE_SIZE) - 1;
  const endX = Math.floor((topLeft.x + state.size.w) / TILE_SIZE) + 1;
  const endY = Math.floor((topLeft.y + state.size.h) / TILE_SIZE) + 1;

  ctx.fillStyle = '#10283c';
  ctx.fillRect(0, 0, state.size.w, state.size.h);
  for (let ty = startY; ty <= endY; ty++) {
    for (let tx = startX; tx <= endX; tx++) {
      const img = loadTile(z, tx, ty);
      const dx = Math.round(tx * TILE_SIZE - topLeft.x);
      const dy = Math.round(ty * TILE_SIZE - topLeft.y);
      if (img && img.complete && img.naturalWidth > 0) ctx.drawImage(img, dx, dy, TILE_SIZE, TILE_SIZE);
      else {
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(dx, dy, TILE_SIZE, TILE_SIZE);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.strokeRect(dx, dy, TILE_SIZE, TILE_SIZE);
      }
    }
  }
}

function visibleTilesForZoom(z, paddingTiles = 1) {
  const centerWorld = lonLatToWorld(state.center.lon, state.center.lat, z);
  const topLeft = { x: centerWorld.x - state.size.w / 2, y: centerWorld.y - state.size.h / 2 };
  const startX = Math.floor(topLeft.x / TILE_SIZE) - paddingTiles;
  const startY = Math.floor(topLeft.y / TILE_SIZE) - paddingTiles;
  const endX = Math.floor((topLeft.x + state.size.w) / TILE_SIZE) + paddingTiles;
  const endY = Math.floor((topLeft.y + state.size.h) / TILE_SIZE) + paddingTiles;
  const n = 2 ** z;
  const tiles = [];
  for (let y = startY; y <= endY; y++) {
    if (y < 0 || y >= n) continue;
    for (let x = startX; x <= endX; x++) {
      const wrappedX = ((x % n) + n) % n;
      tiles.push({ z, x: wrappedX, y });
    }
  }
  return tiles;
}

async function cacheCurrentMapArea() {
  if (effectiveMapLayer() !== 'online') {
    setStatus('Niet nodig', 'De lichte vectorkaart zit al in de app. Schakel naar online detailkaart om extra tiles op te slaan.', 'neutral');
    return;
  }
  if (!('caches' in window)) {
    setStatus('Geen cache', 'Deze browser ondersteunt geen Cache Storage.', 'bad');
    return;
  }
  const btn = $('cacheMapBtn');
  btn.disabled = true;
  const original = btn.textContent;
  const zooms = Array.from(new Set([state.zoom - 1, state.zoom, state.zoom + 1].filter((z) => z >= MIN_ZOOM && z <= MAX_ZOOM)));
  const tiles = zooms.flatMap((z) => visibleTilesForZoom(z, 2));
  const unique = [];
  const seen = new Set();
  for (const t of tiles) {
    const key = `${t.z}/${t.x}/${t.y}`;
    if (!seen.has(key)) { seen.add(key); unique.push(t); }
  }

  try {
    const cache = await caches.open('boot-route-editor-v18-tile-cache');
    let done = 0;
    for (const t of unique) {
      const url = getTileUrl(t.z, t.x, t.y);
      try {
        const res = await fetch(url, { mode: 'no-cors', cache: 'reload' });
        await cache.put(url, res.clone());
      } catch (err) {
        console.warn('Tile niet opgeslagen', url, err);
      }
      done += 1;
      if (done % 5 === 0 || done === unique.length) {
        btn.textContent = `Opslaan ${done}/${unique.length}`;
        setStatus('Kaart opslaan', `Kaarttegels opgeslagen: ${done}/${unique.length}.`, 'neutral');
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }
    setStatus('Kaart opgeslagen', `Dit kaartgebied is opgeslagen voor offline gebruik (${unique.length} tegels).`, 'good');
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}


function drawSimpleOfflineMap() {
  ctx.fillStyle = '#0c2a42';
  ctx.fillRect(0, 0, state.size.w, state.size.h);
  ctx.save();

  const features = state.offlineSimpleMap?.features || [];
  for (const f of features) {
    const p = f.properties || {};
    const g = f.geometry || {};
    if (g.type === 'Polygon') drawSimplePolygon(g.coordinates, p);
    if (g.type === 'MultiPolygon') for (const poly of g.coordinates) drawSimplePolygon(poly, p);
  }
  for (const f of features) {
    const p = f.properties || {};
    const g = f.geometry || {};
    if (g.type === 'LineString') drawSimpleMapLine(g.coordinates, p);
    if (g.type === 'MultiLineString') for (const line of g.coordinates) drawSimpleMapLine(line, p);
  }
  if (state.zoom >= 9) {
    for (const f of features) {
      const p = f.properties || {};
      const g = f.geometry || {};
      if (g.type === 'Point' && p.name) drawSimpleMapLabel(g.coordinates[0], g.coordinates[1], p.name, p.kind);
    }
  }

  // Rasterachtige graticule geeft offline houvast zonder internet.
  drawSimpleGrid();
  ctx.restore();
}

function drawSimplePolygon(rings, props = {}) {
  if (!Array.isArray(rings) || !rings.length) return;
  ctx.save();
  ctx.beginPath();
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 3) continue;
    ring.forEach(([lon, lat], idx) => {
      const pt = project(lon, lat);
      if (idx === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    });
    ctx.closePath();
  }
  if (props.kind === 'water') {
    ctx.fillStyle = 'rgba(46, 137, 187, 0.55)';
    ctx.strokeStyle = 'rgba(126, 213, 255, 0.55)';
  } else {
    ctx.fillStyle = 'rgba(27, 64, 55, 0.86)';
    ctx.strokeStyle = 'rgba(190, 230, 205, 0.25)';
  }
  ctx.lineWidth = 1.2;
  ctx.fill('evenodd');
  ctx.stroke();
  ctx.restore();
}

function drawSimpleMapLine(coords, props = {}) {
  if (!Array.isArray(coords) || coords.length < 2) return;
  const kind = props.kind || 'waterway';
  const major = props.major === true;
  drawLine(coords, {
    color: kind === 'route_hint' ? 'rgba(161, 220, 255, 0.55)' : '#5ec9ff',
    width: major ? 5 : 3,
    alpha: kind === 'route_hint' ? 0.45 : 0.75
  });
  if (state.zoom >= 10 && props.name) {
    const mid = coords[Math.floor(coords.length / 2)];
    drawSimpleMapLabel(mid[0], mid[1], props.name, 'waterway');
  }
}

function drawSimpleMapLabel(lon, lat, text, kind = 'place') {
  const pt = project(lon, lat);
  ctx.save();
  ctx.font = `${kind === 'place' ? '700' : '600'} ${kind === 'place' ? 12 : 11}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(0,0,0,.45)';
  const w = ctx.measureText(text).width + 8;
  ctx.fillRect(pt.x - w / 2, pt.y - 9, w, 18);
  ctx.fillStyle = kind === 'waterway' ? '#b9edff' : '#eaf7ef';
  ctx.fillText(text, pt.x, pt.y);
  ctx.restore();
}

function drawSimpleGrid() {
  const step = state.zoom >= 13 ? 0.02 : state.zoom >= 11 ? 0.05 : 0.1;
  const nw = unproject(0, 0);
  const se = unproject(state.size.w, state.size.h);
  const minLon = Math.min(nw.lon, se.lon), maxLon = Math.max(nw.lon, se.lon);
  const minLat = Math.min(nw.lat, se.lat), maxLat = Math.max(nw.lat, se.lat);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.045)';
  ctx.lineWidth = 1;
  for (let lon = Math.floor(minLon / step) * step; lon <= maxLon; lon += step) {
    const a = project(lon, minLat), b = project(lon, maxLat);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (let lat = Math.floor(minLat / step) * step; lat <= maxLat; lat += step) {
    const a = project(minLon, lat), b = project(maxLon, lat);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  ctx.restore();
}

function drawMapBackground() {
  if (effectiveMapLayer() === 'simple') drawSimpleOfflineMap();
  else drawTiles();
  updateMapLayerUi();
}

function drawLine(coords, style = {}) {
  if (!coords || coords.length < 2) return;
  ctx.save();
  ctx.lineWidth = style.width ?? 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = style.color ?? '#3bb8ff';
  ctx.globalAlpha = style.alpha ?? 1;
  if (style.dash) ctx.setLineDash(style.dash);
  ctx.beginPath();
  coords.forEach(([lon, lat], idx) => {
    const p = project(lon, lat);
    if (idx === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
  ctx.restore();
}

function drawPointMarker(lon, lat, options = {}) {
  const p = project(lon, lat);
  const r = options.r ?? 7;
  ctx.save();
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fillStyle = options.fill ?? '#fff';
  ctx.fill();
  ctx.lineWidth = options.lineWidth ?? 2;
  ctx.strokeStyle = options.stroke ?? '#062033';
  ctx.stroke();
  if (options.text) {
    ctx.fillStyle = options.textColor ?? '#062033';
    ctx.font = `700 ${Math.max(11, r + 3)}px system-ui`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(options.text, p.x, p.y + 0.5);
  }
  ctx.restore();
  return p;
}

function routeFeatures() {
  return (state.customNetwork.features || []).filter((f) => f?.properties?.kind === 'route' && f.geometry?.type === 'LineString');
}
function bridgeFeatures() {
  return (state.customNetwork.features || []).filter((f) => f?.properties?.kind === 'bridge' && f.geometry?.type === 'Point');
}

function drawCustomNetwork() {
  const routes = routeFeatures();
  for (const f of routes) {
    const selected = f.properties.id === state.selectedRouteId;
    const enabled = f.properties.enabled !== false;
    drawLine(f.geometry.coordinates, { color: selected ? '#62e3b3' : '#37aefa', width: selected ? 7 : 5, alpha: enabled ? 0.88 : 0.35 });
    if (state.zoom >= 15) {
      for (const [lon, lat] of f.geometry.coordinates) drawPointMarker(lon, lat, { r: selected ? 4.5 : 3.5, fill: selected ? '#62e3b3' : '#b8eaff', stroke: '#07324b', lineWidth: 1 });
    }
    if (state.zoom >= 14 && f.properties.name) {
      const mid = f.geometry.coordinates[Math.floor(f.geometry.coordinates.length / 2)];
      drawLabel(mid[0], mid[1], f.properties.name, selected ? '#62e3b3' : '#cceeff');
    }
  }

  if (state.routeDraft.length) {
    drawLine(state.routeDraft.map((p) => [p.lon, p.lat]), { color: '#ffdd78', width: 5, dash: [10, 6] });
    state.routeDraft.forEach((p, idx) => drawPointMarker(p.lon, p.lat, { r: 7, fill: '#ffdd78', stroke: '#4c3705', text: String(idx + 1), textColor: '#3a2900' }));
  }

  const bridges = bridgeFeatures();
  for (const f of bridges) {
    const p = f.properties || {};
    const [lon, lat] = f.geometry.coordinates;
    const selected = p.id === state.selectedBridgeId;
    const enabled = p.enabled !== false;
    const fill = !enabled ? '#9099a1' : (p.type === 'lock' ? '#b990ff' : (p.openable ? '#ffbf4d' : '#ff7b72'));
    drawPointMarker(lon, lat, { r: selected ? 10 : 8, fill, stroke: selected ? '#ffffff' : '#0b2235', text: p.type === 'lock' ? 'S' : 'B', textColor: '#111' });
    if (state.zoom >= 14 && p.name) drawLabel(lon, lat, p.name, selected ? '#ffffff' : '#ffe6d0', 13, 14);
  }
}

function drawLabel(lon, lat, text, color = '#fff', size = 12, dy = -14) {
  const p = project(lon, lat);
  ctx.save();
  ctx.font = `700 ${size}px system-ui`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  const w = ctx.measureText(text).width + 10;
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.fillRect(p.x - w / 2, p.y + dy - size - 5, w, size + 6);
  ctx.fillStyle = color;
  ctx.fillText(text, p.x, p.y + dy);
  ctx.restore();
}

function drawRouteResult() {
  if (state.plannedRoute && state.plannedRoute.length >= 2) {
    drawLine(state.plannedRoute.map((p) => [p.lon, p.lat]), { color: '#f05cff', width: 8, alpha: 0.9 });
    drawLine(state.plannedRoute.map((p) => [p.lon, p.lat]), { color: '#ffffff', width: 3, alpha: 0.8 });
  }
  if (state.routeStart) drawPointMarker(state.routeStart.lon, state.routeStart.lat, { r: 12, fill: '#62e3b3', stroke: '#063025', text: 'A', textColor: '#063025' });
  if (state.routeEnd) drawPointMarker(state.routeEnd.lon, state.routeEnd.lat, { r: 12, fill: '#ff6b6b', stroke: '#300606', text: 'B', textColor: '#300606' });
}

function drawUser() {
  if (!state.user) return;
  drawPointMarker(state.user.lon, state.user.lat, { r: 9, fill: '#2f86ff', stroke: '#fff' });
  if (state.user.accuracy) {
    const p = project(state.user.lon, state.user.lat);
    const edge = destinationPoint(state.user, state.user.accuracy, 90);
    const pe = project(edge.lon, edge.lat);
    const r = Math.abs(pe.x - p.x);
    ctx.save();
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(47,134,255,.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(47,134,255,.35)';
    ctx.stroke();
    ctx.restore();
  }
}

function destinationPoint(origin, distanceM, bearingDeg) {
  const R = 6371000;
  const brng = bearingDeg * Math.PI / 180;
  const lat1 = origin.lat * Math.PI / 180;
  const lon1 = origin.lon * Math.PI / 180;
  const d = distanceM / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: lat2 * 180 / Math.PI, lon: lon2 * 180 / Math.PI };
}

function drawModeBanner() {
  let text = '';
  if (state.routePickMode === 'start') text = 'Tik op de kaart om startpunt A te kiezen';
  if (state.routePickMode === 'end') text = 'Tik op de kaart om bestemming B te kiezen';
  if (state.editorMode === 'drawRoute' && state.routeDraft.length) text = `Route tekenen: ${state.routeDraft.length} punt(en). Tik verder of sla op.`;
  if (state.bridgePickMode) text = 'Tik op de kaart om de brug/sluis exact te plaatsen';
  if (!text) return;
  ctx.save();
  ctx.font = '700 15px system-ui';
  const w = Math.min(state.size.w - 28, ctx.measureText(text).width + 28);
  const x = state.size.w / 2 - w / 2;
  const y = 82;
  ctx.fillStyle = 'rgba(7,27,44,.90)';
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  roundRect(x, y, w, 42, 15);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, state.size.w / 2, y + 21);
  ctx.restore();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw() {
  if (!ctx) return;
  drawMapBackground();
  drawCustomNetwork();
  drawRouteResult();
  drawUser();
  drawModeBanner();
}

function canonicalNetwork(input) {
  const out = emptyNetwork();
  const features = Array.isArray(input?.features) ? input.features : [];
  for (const f of features) {
    if (!f || f.type !== 'Feature' || !f.geometry) continue;
    const p = { ...(f.properties || {}) };
    if (!p.kind) {
      if (f.geometry.type === 'LineString') p.kind = 'route';
      if (f.geometry.type === 'Point') p.kind = 'bridge';
    }
    if (!p.id) p.id = uid(p.kind || 'feature');
    if (p.enabled === undefined) p.enabled = true;
    if (p.kind === 'route' && f.geometry.type === 'LineString') {
      const coords = (f.geometry.coordinates || []).filter((c) => Array.isArray(c) && Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1]))).map((c) => [Number(c[0]), Number(c[1])]);
      if (coords.length >= 2) out.features.push({ type: 'Feature', properties: p, geometry: { type: 'LineString', coordinates: coords } });
    }
    if (p.kind === 'bridge' && f.geometry.type === 'Point') {
      const c = f.geometry.coordinates || [];
      if (Number.isFinite(Number(c[0])) && Number.isFinite(Number(c[1]))) {
        p.radiusM = parseNum(p.radiusM) ?? BRIDGE_DEFAULT_RADIUS_M;
        p.heightM = parseNullableNumber(p.heightM);
        p.widthM = parseNullableNumber(p.widthM);
        p.depthM = parseNullableNumber(p.depthM);
        p.lengthM = parseNullableNumber(p.lengthM);
        if (!p.type) p.type = 'fixed_bridge';
        p.openable = Boolean(p.openable);
        out.features.push({ type: 'Feature', properties: p, geometry: { type: 'Point', coordinates: [Number(c[0]), Number(c[1])] } });
      }
    }
  }
  return out;
}

function parseNullableNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function loadNetwork() {
  let hardcoded = emptyNetwork();
  try {
    const res = await fetch('data/custom_network.geojson', { cache: 'no-store' });
    if (res.ok) hardcoded = canonicalNetwork(await res.json());
  } catch (err) {
    console.warn('Kon hardcoded netwerk niet laden', err);
  }
  state.hardcodedNetwork = hardcoded;
  const local = localStorage.getItem(STORAGE_KEY);
  if (local) {
    try {
      state.customNetwork = canonicalNetwork(JSON.parse(local));
      state.usesBrowserData = true;
    } catch (err) {
      state.customNetwork = structuredClone(hardcoded);
      state.usesBrowserData = false;
    }
  } else {
    state.customNetwork = structuredClone(hardcoded);
    state.usesBrowserData = false;
  }
  invalidateGraph();
  updateNetworkSummary();
}

function saveBrowserNetwork() {
  state.customNetwork.version = 1;
  state.customNetwork.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.customNetwork));
  state.usesBrowserData = true;
  invalidateGraph();
  updateNetworkSummary();
  draw();
}

function clearBrowserNetwork() {
  if (!confirm('Browserdata wissen en terug naar hardcoded data/custom_network.geojson?')) return;
  localStorage.removeItem(STORAGE_KEY);
  state.customNetwork = structuredClone(state.hardcodedNetwork);
  state.usesBrowserData = false;
  state.selectedBridgeId = null;
  state.selectedRouteId = null;
  state.routeDraft = [];
  state.plannedRoute = [];
  invalidateGraph();
  updateNetworkSummary();
  populateBridgeSelect();
  clearBridgeForm();
  setEditorStatus('Browserdata gewist. Je ziet nu weer alleen hardcoded data.');
  draw();
}

function updateNetworkSummary() {
  const r = routeFeatures().length;
  const b = bridgeFeatures().length;
  $('networkSummary').textContent = `${r} route${r === 1 ? '' : 's'} · ${b} brug${b === 1 ? '' : 'gen'}`;
  $('storageState').textContent = state.usesBrowserData ? 'Browserdata actief' : 'Hardcoded data';
}

function invalidateGraph() {
  state.routeGraph = null;
  state.plannedRoute = [];
  state.routeNotices = [];
  updateRouteButtons();
}

function loadBoatProfile() {
  try {
    const stored = JSON.parse(localStorage.getItem(BOAT_KEY) || 'null');
    if (stored) state.boatProfile = { ...state.boatProfile, ...stored };
  } catch {}
  updateBoatProfileForm();
  updateBoatSummary();
}

function saveBoatProfile() {
  state.boatProfile = {
    heightM: parseNum($('boatHeight').value),
    widthM: parseNum($('boatWidth').value),
    draftM: parseNum($('boatDraft').value),
    marginM: parseNum($('boatMargin').value) ?? 0,
    blockUnknownPassages: $('boatBlockUnknown').checked
  };
  localStorage.setItem(BOAT_KEY, JSON.stringify(state.boatProfile));
  updateBoatSummary();
  setRouteStatus('Bootformaat opgeslagen. Bereken de route opnieuw om bruggen opnieuw te controleren.');
}

function updateBoatProfileForm() {
  const b = state.boatProfile;
  $('boatHeight').value = b.heightM ?? '';
  $('boatWidth').value = b.widthM ?? '';
  $('boatDraft').value = b.draftM ?? '';
  $('boatMargin').value = b.marginM ?? 0;
  $('boatBlockUnknown').checked = Boolean(b.blockUnknownPassages);
}

function updateBoatSummary() {
  const b = state.boatProfile;
  const parts = [];
  if (b.heightM !== null) parts.push(`H ${b.heightM} m`);
  if (b.widthM !== null) parts.push(`B ${b.widthM} m`);
  if (b.draftM !== null) parts.push(`D ${b.draftM} m`);
  if (parts.length) parts.push(`marge ${b.marginM ?? 0} m`);
  $('boatProfileSummary').textContent = parts.length ? parts.join(' · ') : 'Niet ingesteld';
}

function buildGraph() {
  if (state.routeGraph) return state.routeGraph;
  const nodes = [];
  const edges = new Map();
  const segmentIndex = [];

  function addNode(point) {
    for (let i = 0; i < nodes.length; i++) {
      if (haversine(point, nodes[i]) <= JOIN_TOLERANCE_M) return i;
    }
    nodes.push({ lon: point.lon, lat: point.lat });
    edges.set(nodes.length - 1, []);
    return nodes.length - 1;
  }

  function addEdge(a, b, segment) {
    if (a === b) return;
    const dist = haversine(nodes[a], nodes[b]);
    const e1 = { to: b, dist, segment };
    const e2 = { to: a, dist, segment };
    edges.get(a).push(e1);
    edges.get(b).push(e2);
  }

  const routes = routeFeatures().filter((f) => f.properties.enabled !== false);
  for (const f of routes) {
    const coords = f.geometry.coordinates;
    const nodeIds = coords.map(([lon, lat]) => addNode({ lon, lat }));
    for (let i = 0; i < coords.length - 1; i++) {
      const aP = { lon: coords[i][0], lat: coords[i][1] };
      const bP = { lon: coords[i + 1][0], lat: coords[i + 1][1] };
      const segment = { routeId: f.properties.id, routeName: f.properties.name || 'Naamloze route', a: aP, b: bP };
      segmentIndex.push({ ...segment, nodeA: nodeIds[i], nodeB: nodeIds[i + 1] });
      addEdge(nodeIds[i], nodeIds[i + 1], segment);
    }
  }
  state.routeGraph = { nodes, edges, segmentIndex };
  return state.routeGraph;
}

function constraintsForSegment(segment) {
  const bridges = bridgeFeatures().filter((f) => f.properties.enabled !== false);
  const hits = [];
  for (const f of bridges) {
    const p = f.properties || {};
    const radius = parseNum(p.radiusM) ?? BRIDGE_DEFAULT_RADIUS_M;
    const point = { lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
    const d = pointToSegmentDistanceM(point, segment.a, segment.b);
    if (d <= radius) hits.push({ feature: f, distanceM: d });
  }
  return hits;
}

function bridgeCheck(hit) {
  const p = hit.feature.properties || {};
  const boat = state.boatProfile;
  const margin = boat.marginM ?? 0;
  const requiredHeight = boat.heightM !== null ? boat.heightM + margin : null;
  const requiredWidth = boat.widthM !== null ? boat.widthM + margin : null;
  const requiredDepth = boat.draftM !== null ? boat.draftM + margin : null;
  const isOpenable = Boolean(p.openable) || p.type === 'movable_bridge' || p.type === 'lock';
  const name = p.name || 'Naamloze brug/sluis';
  const notices = [];

  if (requiredWidth !== null && p.widthM !== null && requiredWidth > p.widthM) return { ok: false, reason: `${name}: te smal (${p.widthM} m, nodig ${requiredWidth.toFixed(2)} m)` };
  if (requiredDepth !== null && p.depthM !== null && requiredDepth > p.depthM) return { ok: false, reason: `${name}: te ondiep (${p.depthM} m, nodig ${requiredDepth.toFixed(2)} m)` };

  if (requiredHeight !== null) {
    if (p.heightM !== null && requiredHeight > p.heightM) {
      if (isOpenable) notices.push(`${name}: hoogte past gesloten niet (${p.heightM} m), bediening/opening nodig.`);
      else return { ok: false, reason: `${name}: te laag (${p.heightM} m, nodig ${requiredHeight.toFixed(2)} m)` };
    } else if (p.heightM === null && state.boatProfile.blockUnknownPassages && !isOpenable) {
      return { ok: false, reason: `${name}: vaste brug met onbekende hoogte geblokkeerd` };
    }
  }

  if (requiredWidth !== null && p.widthM === null && state.boatProfile.blockUnknownPassages && !isOpenable) {
    return { ok: false, reason: `${name}: vaste brug met onbekende breedte geblokkeerd` };
  }
  if (requiredDepth !== null && p.depthM === null && state.boatProfile.blockUnknownPassages) {
    return { ok: false, reason: `${name}: onbekende diepte geblokkeerd` };
  }
  if (isOpenable) notices.push(`${name}: beweegbare brug/sluis, controleer bediening/stremming.`);
  return { ok: true, notices };
}

function edgeAllowed(edge) {
  const hits = constraintsForSegment(edge.segment);
  const notices = [];
  for (const hit of hits) {
    const check = bridgeCheck(hit);
    if (!check.ok) return { ok: false, reason: check.reason };
    notices.push(...(check.notices || []));
  }
  return { ok: true, notices };
}

function findClosestSegment(point) {
  const graph = buildGraph();
  let best = null;
  for (const seg of graph.segmentIndex) {
    const cp = closestPointOnSegment(point, seg.a, seg.b);
    if (!best || cp.distanceM < best.distanceM) best = { ...seg, ...cp };
  }
  return best;
}

function calculateRoute() {
  if (!state.routeStart || !state.routeEnd) return;
  const graphBase = buildGraph();
  if (!graphBase.nodes.length) {
    setRouteStatus('Geen route mogelijk: teken eerst minimaal één vaarroute in de editor.');
    return;
  }
  const startSnap = findClosestSegment(state.routeStart);
  const endSnap = findClosestSegment(state.routeEnd);
  if (!startSnap || startSnap.distanceM > SNAP_MAX_M) {
    setRouteStatus(`Startpunt ligt te ver van je ingetekende vaarroutes (${Math.round(startSnap?.distanceM ?? 0)} m).`);
    return;
  }
  if (!endSnap || endSnap.distanceM > SNAP_MAX_M) {
    setRouteStatus(`Bestemming ligt te ver van je ingetekende vaarroutes (${Math.round(endSnap?.distanceM ?? 0)} m).`);
    return;
  }

  const graph = cloneGraphWithSnaps(graphBase, startSnap, endSnap);
  const result = dijkstra(graph, graph.startId, graph.endId);
  if (!result) {
    setRouteStatus('Geen route gevonden. Waarschijnlijk blokkeert een brug/sluis of zijn je routes nog niet verbonden.');
    state.plannedRoute = [];
    state.routeNotices = [];
    updateRouteNotices();
    draw();
    return;
  }

  state.plannedRoute = result.path.map((id) => graph.nodes[id]);
  state.routeNotices = [...new Set(result.notices)];
  const km = result.distanceM / 1000;
  setRouteStatus(`Route gevonden: ${km.toFixed(km >= 10 ? 1 : 2)} km over jouw eigen routenetwerk.`);
  updateRouteNotices();
  draw();
}

function cloneGraphWithSnaps(base, startSnap, endSnap) {
  const nodes = base.nodes.map((p) => ({ ...p }));
  const edges = new Map();
  for (const [k, list] of base.edges.entries()) edges.set(k, list.map((e) => ({ ...e })));

  function addNode(p) {
    const id = nodes.length;
    nodes.push({ lon: p.lon, lat: p.lat });
    edges.set(id, []);
    return id;
  }
  function addEdge(a, b, segment) {
    const dist = haversine(nodes[a], nodes[b]);
    const e1 = { to: b, dist, segment };
    const e2 = { to: a, dist, segment };
    edges.get(a).push(e1);
    edges.get(b).push(e2);
  }
  function addSnap(snap, label) {
    const id = addNode(snap.point);
    const segToA = { routeId: snap.routeId, routeName: snap.routeName, a: snap.point, b: snap.a };
    const segToB = { routeId: snap.routeId, routeName: snap.routeName, a: snap.point, b: snap.b };
    addEdge(id, snap.nodeA, segToA);
    addEdge(id, snap.nodeB, segToB);
    return id;
  }
  const startId = addSnap(startSnap, 'start');
  const endId = addSnap(endSnap, 'end');
  return { nodes, edges, startId, endId };
}

function dijkstra(graph, start, end) {
  const dist = new Map([[start, 0]]);
  const prev = new Map();
  const prevNotices = new Map();
  const visited = new Set();
  const queue = [{ id: start, d: 0 }];
  const finalNotices = new Map([[start, []]]);

  while (queue.length) {
    queue.sort((a, b) => a.d - b.d);
    const cur = queue.shift();
    if (visited.has(cur.id)) continue;
    visited.add(cur.id);
    if (cur.id === end) break;
    for (const edge of graph.edges.get(cur.id) || []) {
      if (visited.has(edge.to)) continue;
      const allowed = edgeAllowed(edge);
      if (!allowed.ok) continue;
      const nd = cur.d + edge.dist;
      if (nd < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, nd);
        prev.set(edge.to, cur.id);
        const notices = [...(finalNotices.get(cur.id) || []), ...(allowed.notices || [])];
        finalNotices.set(edge.to, notices);
        queue.push({ id: edge.to, d: nd });
      }
    }
  }
  if (!dist.has(end)) return null;
  const path = [];
  let at = end;
  while (at !== undefined) {
    path.push(at);
    if (at === start) break;
    at = prev.get(at);
  }
  path.reverse();
  return { path, distanceM: dist.get(end), notices: finalNotices.get(end) || [] };
}

function updateRouteNotices() {
  const box = $('routeNotices');
  if (!state.routeNotices.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = `<strong>Controlepunten</strong><ul>${state.routeNotices.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function setRoutePoint(kind, point) {
  if (kind === 'start') state.routeStart = point;
  if (kind === 'end') state.routeEnd = point;
  state.routePickMode = null;
  state.plannedRoute = [];
  updateRoutePanel();
  draw();
}

function updateRoutePanel() {
  $('routeStartText').textContent = formatCoord(state.routeStart);
  $('routeEndText').textContent = formatCoord(state.routeEnd);
  updateRouteButtons();
}

function updateRouteButtons() {
  const hasRoutes = routeFeatures().some((f) => f.properties.enabled !== false);
  $('routeCalcBtn').disabled = !(state.routeStart && state.routeEnd && hasRoutes);
  $('routeGpsBtn').disabled = !state.user;
}

function setEditorMode(mode) {
  state.editorMode = mode;
  state.routePickMode = null;
  state.bridgePickMode = mode === 'placeBridge';
  $('selectModeBtn').classList.toggle('active', mode === 'select');
  $('drawRouteModeBtn').classList.toggle('active', mode === 'drawRoute');
  $('placeBridgeModeBtn').classList.toggle('active', mode === 'placeBridge');
  if (mode === 'select') setEditorStatus('Selecteer een route of brug op de kaart, of kies een editorknop.');
  if (mode === 'drawRoute') setEditorStatus('Route tekenen actief. Tik op de kaart om punten te plaatsen.');
  if (mode === 'placeBridge') setEditorStatus('Brug plaatsen actief. Tik precies op de doorvaart/bruglocatie.');
  draw();
}

function startRouteDrawing() {
  state.routeDraft = [];
  state.selectedRouteId = null;
  $('routeNameInput').value = '';
  setEditorMode('drawRoute');
  setEditorStatus('Nieuwe route gestart. Tik minimaal twee punten op de kaart.');
}

function saveRouteDraft() {
  if (state.routeDraft.length < 2) {
    setEditorStatus('Een route heeft minimaal twee punten nodig.');
    return;
  }
  const name = $('routeNameInput').value.trim() || `Route ${routeFeatures().length + 1}`;
  const feature = {
    type: 'Feature',
    properties: { id: uid('route'), kind: 'route', name, enabled: true, createdAt: new Date().toISOString() },
    geometry: { type: 'LineString', coordinates: state.routeDraft.map((p) => [roundCoord(p.lon), roundCoord(p.lat)]) }
  };
  state.customNetwork.features.push(feature);
  state.routeDraft = [];
  state.selectedRouteId = feature.properties.id;
  saveBrowserNetwork();
  setEditorMode('select');
  setEditorStatus(`Route opgeslagen: ${name}. Plaats nu bruggen/sluispunten op deze route.`);
}

function roundCoord(n) { return Number(n.toFixed(7)); }

function renameSelectedRoute() {
  if (!state.selectedRouteId) {
    setEditorStatus('Geen route geselecteerd. Tik eerst op een blauwe route in selectiemodus.');
    return;
  }
  const f = routeFeatures().find((r) => r.properties.id === state.selectedRouteId);
  if (!f) return;
  const name = $('routeNameInput').value.trim() || f.properties.name || 'Naamloze route';
  f.properties.name = name;
  f.properties.updatedAt = new Date().toISOString();
  saveBrowserNetwork();
  setEditorStatus(`Routenaam opgeslagen: ${name}.`);
}

function deleteSelectedRoute() {
  if (!state.selectedRouteId) {
    setEditorStatus('Geen route geselecteerd om te verwijderen.');
    return;
  }
  const f = routeFeatures().find((r) => r.properties.id === state.selectedRouteId);
  const name = f?.properties?.name || 'deze route';
  if (!confirm(`Weet je zeker dat je ${name} wilt verwijderen?`)) return;
  state.customNetwork.features = state.customNetwork.features.filter((x) => x.properties?.id !== state.selectedRouteId);
  state.selectedRouteId = null;
  $('routeNameInput').value = '';
  saveBrowserNetwork();
  setEditorStatus('Route verwijderd. Let op: bruggen die op die route stonden blijven bestaan, maar doen pas weer mee als er een route onder ligt.');
}


function undoRoutePoint() {
  state.routeDraft.pop();
  setEditorStatus(`Laatste punt verwijderd. Huidig aantal punten: ${state.routeDraft.length}.`);
  draw();
}

function cancelRouteDrawing() {
  state.routeDraft = [];
  setEditorMode('select');
  setEditorStatus('Route tekenen geannuleerd.');
  draw();
}

function newBridgeForm() {
  state.selectedBridgeId = null;
  clearBridgeForm();
  setEditorMode('placeBridge');
  setEditorStatus('Nieuwe brug/sluis: vul naam en maten in, plaats hem daarna op de kaart.');
}

function clearBridgeForm() {
  $('bridgeSelect').value = '';
  $('bridgeName').value = '';
  $('bridgeHeight').value = '';
  $('bridgeWidth').value = '';
  $('bridgeDepth').value = '';
  $('bridgeLength').value = '';
  $('bridgeType').value = 'fixed_bridge';
  $('bridgeRadius').value = BRIDGE_DEFAULT_RADIUS_M;
  $('bridgeOpenable').checked = false;
  $('bridgeEnabled').checked = true;
  $('bridgeLon').value = '';
  $('bridgeLat').value = '';
  $('bridgeNotes').value = '';
}

function populateBridgeSelect() {
  const select = $('bridgeSelect');
  const bridges = bridgeFeatures();
  select.innerHTML = '<option value="">Nieuwe brug/sluis</option>' + bridges.map((f) => `<option value="${escapeHtml(f.properties.id)}">${escapeHtml(f.properties.name || 'Naamloos')}</option>`).join('');
  if (state.selectedBridgeId) select.value = state.selectedBridgeId;
}

function loadBridgeToForm(id) {
  const f = bridgeFeatures().find((x) => x.properties.id === id);
  if (!f) return;
  state.selectedBridgeId = id;
  state.selectedRouteId = null;
  const p = f.properties;
  $('bridgeSelect').value = id;
  $('bridgeName').value = p.name || '';
  $('bridgeHeight').value = p.heightM ?? '';
  $('bridgeWidth').value = p.widthM ?? '';
  $('bridgeDepth').value = p.depthM ?? '';
  $('bridgeLength').value = p.lengthM ?? '';
  $('bridgeType').value = p.type || 'fixed_bridge';
  $('bridgeRadius').value = p.radiusM ?? BRIDGE_DEFAULT_RADIUS_M;
  $('bridgeOpenable').checked = Boolean(p.openable);
  $('bridgeEnabled').checked = p.enabled !== false;
  $('bridgeLon').value = f.geometry.coordinates[0];
  $('bridgeLat').value = f.geometry.coordinates[1];
  $('bridgeNotes').value = p.notes || '';
  setEditorStatus(`Brug geselecteerd: ${p.name || 'naamloos'}.`);
  draw();
}

function saveBridgeFromForm() {
  const lon = parseNum($('bridgeLon').value);
  const lat = parseNum($('bridgeLat').value);
  if (lon === null || lat === null) {
    setEditorStatus('Plaats eerst de brug op de kaart of vul longitude/latitude in.');
    return;
  }
  const name = $('bridgeName').value.trim() || `Brug ${bridgeFeatures().length + 1}`;
  const props = {
    id: state.selectedBridgeId || uid('bridge'),
    kind: 'bridge',
    name,
    type: $('bridgeType').value,
    heightM: parseNum($('bridgeHeight').value),
    widthM: parseNum($('bridgeWidth').value),
    depthM: parseNum($('bridgeDepth').value),
    lengthM: parseNum($('bridgeLength').value),
    radiusM: parseNum($('bridgeRadius').value) ?? BRIDGE_DEFAULT_RADIUS_M,
    openable: $('bridgeOpenable').checked,
    enabled: $('bridgeEnabled').checked,
    notes: $('bridgeNotes').value.trim(),
    updatedAt: new Date().toISOString()
  };
  const feature = { type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: [roundCoord(lon), roundCoord(lat)] } };
  const idx = state.customNetwork.features.findIndex((f) => f.properties?.id === props.id);
  if (idx >= 0) state.customNetwork.features[idx] = feature;
  else state.customNetwork.features.push(feature);
  state.selectedBridgeId = props.id;
  saveBrowserNetwork();
  populateBridgeSelect();
  $('bridgeSelect').value = props.id;
  setEditorMode('select');
  setEditorStatus(`Brug/sluis opgeslagen: ${name}. De routeplanner gebruikt deze nu als blokkade/controlepunt.`);
}

function deleteSelectedBridge() {
  if (!state.selectedBridgeId) {
    setEditorStatus('Geen brug geselecteerd om te verwijderen.');
    return;
  }
  const f = bridgeFeatures().find((x) => x.properties.id === state.selectedBridgeId);
  const name = f?.properties?.name || 'deze brug';
  if (!confirm(`Weet je zeker dat je ${name} wilt verwijderen?`)) return;
  state.customNetwork.features = state.customNetwork.features.filter((x) => x.properties?.id !== state.selectedBridgeId);
  state.selectedBridgeId = null;
  clearBridgeForm();
  saveBrowserNetwork();
  populateBridgeSelect();
  setEditorStatus('Brug verwijderd.');
}

function selectFeatureAtScreen(x, y) {
  let best = null;
  for (const f of bridgeFeatures()) {
    const [lon, lat] = f.geometry.coordinates;
    const p = project(lon, lat);
    const d = Math.hypot(x - p.x, y - p.y);
    if (d < 24 && (!best || d < best.d)) best = { type: 'bridge', id: f.properties.id, d };
  }
  for (const f of routeFeatures()) {
    const coords = f.geometry.coordinates;
    for (let i = 0; i < coords.length - 1; i++) {
      const a = project(coords[i][0], coords[i][1]);
      const b = project(coords[i + 1][0], coords[i + 1][1]);
      const d = pointToScreenSegmentDistance(x, y, a, b);
      if (d < 14 && (!best || d < best.d)) best = { type: 'route', id: f.properties.id, d };
    }
  }
  if (!best) {
    state.selectedBridgeId = null;
    state.selectedRouteId = null;
    populateBridgeSelect();
    draw();
    setEditorStatus('Niets geselecteerd.');
    return;
  }
  if (best.type === 'bridge') {
    loadBridgeToForm(best.id);
  } else {
    state.selectedRouteId = best.id;
    state.selectedBridgeId = null;
    const f = routeFeatures().find((r) => r.properties.id === best.id);
    $('routeNameInput').value = f?.properties?.name || '';
    populateBridgeSelect();
    setEditorStatus(`Route geselecteerd: ${f?.properties?.name || 'naamloos'}.`);
    draw();
  }
}

function pointToScreenSegmentDistance(px, py, a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len2 = vx * vx + vy * vy;
  let t = 0;
  if (len2 > 0) t = clamp(((px - a.x) * vx + (py - a.y) * vy) / len2, 0, 1);
  const x = a.x + vx * t;
  const y = a.y + vy * t;
  return Math.hypot(px - x, py - y);
}

function downloadNetwork() {
  const data = canonicalNetwork(state.customNetwork);
  data.updatedAt = new Date().toISOString();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'custom_network.geojson';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  setEditorStatus('GeoJSON gedownload. Vervang hiermee data/custom_network.geojson om het hardcoded te maken.');
}

function importNetworkFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = canonicalNetwork(JSON.parse(reader.result));
      state.customNetwork = parsed;
      saveBrowserNetwork();
      populateBridgeSelect();
      setEditorStatus('GeoJSON geïmporteerd en opgeslagen in browserdata. Download opnieuw om hem hardcoded te maken.');
    } catch (err) {
      setEditorStatus('Import mislukt: dit lijkt geen geldige GeoJSON te zijn.');
    }
  };
  reader.readAsText(file);
}

function startGps() {
  if (!navigator.geolocation) {
    setStatus('Geen GPS', 'Deze browser ondersteunt geen geolocatie.', 'bad');
    return;
  }
  if (state.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
    $('gpsBtn').textContent = 'Start GPS';
    setStatus('GPS uit', 'GPS tracking gestopt.', 'neutral');
    updateGpsUi();
    return;
  }
  state.gpsWatchId = navigator.geolocation.watchPosition(onGps, onGpsError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 12000
  });
  $('gpsBtn').textContent = 'Stop GPS';
  setStatus('GPS', 'GPS wordt gestart…', 'neutral');
}

function onGps(pos) {
  const c = pos.coords;
  state.user = { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy };
  state.lastGpsReceivedAt = Date.now();
  state.speedKmh = c.speed !== null && Number.isFinite(c.speed) ? c.speed * 3.6 : null;
  if (state.follow) state.center = clampCenter({ lat: state.user.lat, lon: state.user.lon });
  updateGpsUi();
  updateRouteButtons();
  setStatus('GPS actief', 'Positie ontvangen.', 'good');
  draw();
}

function onGpsError(err) {
  setStatus('GPS fout', err.message || 'Geen GPS toegang.', 'bad');
  updateGpsUi();
}

function updateGpsUi() {
  const badge = $('gpsBadge');
  if (!state.gpsWatchId) {
    badge.className = 'gpsBadge off';
    $('gpsState').textContent = 'Geen GPS';
  } else if (state.lastGpsReceivedAt && Date.now() - state.lastGpsReceivedAt < GPS_STALE_MS) {
    badge.className = 'gpsBadge on';
    $('gpsState').textContent = 'GPS actief';
  } else {
    badge.className = 'gpsBadge warn';
    $('gpsState').textContent = 'GPS zoeken';
  }
  $('accuracy').textContent = state.user?.accuracy ? `Nauwkeurigheid: ±${Math.round(state.user.accuracy)} m` : 'Nauwkeurigheid: —';
  if (state.speedKmh !== null) {
    $('speed').textContent = Math.max(0, state.speedKmh).toFixed(1);
    $('speedKnots').textContent = (state.speedKmh / 1.852).toFixed(1);
  } else {
    $('speed').textContent = '--';
    $('speedKnots').textContent = '--';
  }
}

function recenter() {
  if (!state.user) return;
  state.center = clampCenter({ lat: state.user.lat, lon: state.user.lon });
  draw();
}

function zoom(delta) {
  state.zoom = clamp(state.zoom + delta, MIN_ZOOM, MAX_ZOOM);
  draw();
}

function togglePanel(panelId) {
  const el = $(panelId);
  const willOpen = el.hidden;
  el.hidden = !el.hidden;
  if (panelId === 'routePanel' && willOpen) {
    $('editorPanel').hidden = true;
    state.bridgePickMode = false;
    updateRoutePanel();
  }
  if (panelId === 'editorPanel' && willOpen) {
    $('routePanel').hidden = true;
    state.routePickMode = null;
    populateBridgeSelect();
    state.editorOpen = true;
  }
  draw();
}

function closeRoutePanel() {
  $('routePanel').hidden = true;
  state.routePickMode = null;
  draw();
}
function closeEditorPanel() {
  $('editorPanel').hidden = true;
  state.bridgePickMode = false;
  if (state.editorMode !== 'drawRoute') state.editorMode = 'select';
  draw();
}

function handleMapClick(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  const ll = unproject(x, y);
  const point = { lon: ll.lon, lat: ll.lat };

  if (state.routePickMode) {
    setRoutePoint(state.routePickMode, point);
    setRouteStatus(`${state.routePickMode === 'start' ? 'Start' : 'Bestemming'} gekozen.`);
    return;
  }
  if (state.editorMode === 'drawRoute') {
    state.routeDraft.push(point);
    setEditorStatus(`Punt ${state.routeDraft.length} toegevoegd. Tik verder of sla de route op.`);
    draw();
    return;
  }
  if (state.bridgePickMode || state.editorMode === 'placeBridge') {
    $('bridgeLon').value = roundCoord(point.lon);
    $('bridgeLat').value = roundCoord(point.lat);
    state.bridgePickMode = false;
    setEditorMode('select');
    setEditorStatus('Bruglocatie geplaatst. Vul maten in en klik op Brug opslaan.');
    draw();
    return;
  }
  if (state.editorMode === 'select' && !$('editorPanel').hidden) {
    selectFeatureAtScreen(x, y);
  }
}

function pointerDown(e) {
  canvas.setPointerCapture(e.pointerId);
  state.dragging = true;
  state.pointerMoved = false;
  state.dragStart = { x: e.clientX, y: e.clientY };
  state.centerStart = { ...state.center };
}

function pointerMove(e) {
  if (!state.dragging) return;
  if (state.routePickMode || state.editorMode === 'drawRoute' || state.bridgePickMode || state.editorMode === 'placeBridge') {
    // In teken- en plaatsmodus mag een kleine vingerbeweging geen punt verpesten.
    return;
  }
  const dx = e.clientX - state.dragStart.x;
  const dy = e.clientY - state.dragStart.y;
  if (Math.hypot(dx, dy) > 5) state.pointerMoved = true;
  const cWorld = lonLatToWorld(state.centerStart.lon, state.centerStart.lat, state.zoom);
  const newCenter = worldToLonLat(cWorld.x - dx, cWorld.y - dy, state.zoom);
  state.center = clampCenter(newCenter);
  if (state.follow) {
    state.follow = false;
    $('followBtn').classList.remove('active');
    $('followBtn').setAttribute('aria-pressed', 'false');
  }
  $('recenterBtn').disabled = !state.user;
  draw();
}

function pointerUp(e) {
  if (!state.dragging) return;
  canvas.releasePointerCapture(e.pointerId);
  state.dragging = false;
  if (!state.pointerMoved) handleMapClick(e.clientX, e.clientY);
}

function wheel(e) {
  e.preventDefault();
  const oldZoom = state.zoom;
  const delta = e.deltaY < 0 ? 1 : -1;
  const newZoom = clamp(state.zoom + delta, MIN_ZOOM, MAX_ZOOM);
  if (newZoom === oldZoom) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;
  const before = unproject(mx, my);
  state.zoom = newZoom;
  const afterWorld = lonLatToWorld(before.lon, before.lat, newZoom);
  const centerWorld = { x: afterWorld.x - (mx - state.size.w / 2), y: afterWorld.y - (my - state.size.h / 2) };
  state.center = clampCenter(worldToLonLat(centerWorld.x, centerWorld.y, newZoom));
  draw();
}

function setupEvents() {
  window.addEventListener('resize', resize);
  canvas.addEventListener('pointerdown', pointerDown);
  canvas.addEventListener('pointermove', pointerMove);
  canvas.addEventListener('pointerup', pointerUp);
  canvas.addEventListener('pointercancel', pointerUp);
  canvas.addEventListener('wheel', wheel, { passive: false });

  $('gpsBtn').addEventListener('click', startGps);
  $('followBtn').addEventListener('click', () => {
    state.follow = !state.follow;
    $('followBtn').classList.toggle('active', state.follow);
    $('followBtn').setAttribute('aria-pressed', String(state.follow));
    if (state.follow && state.user) recenter();
  });
  $('recenterBtn').addEventListener('click', recenter);
  $('zoomIn').addEventListener('click', () => zoom(1));
  $('zoomOut').addEventListener('click', () => zoom(-1));
  $('mapLayerBtn').addEventListener('click', cycleMapLayer);
  $('cacheMapBtn').addEventListener('click', cacheCurrentMapArea);
  window.addEventListener('online', () => { updateMapLayerUi(); draw(); });
  window.addEventListener('offline', () => { updateMapLayerUi(); setStatus('Offline', 'Vectorkaart actief. Eigen routes/bruggen blijven op dezelfde GPS-coördinaten.', 'good'); draw(); });

  $('dashSizeBtn').addEventListener('click', () => {
    $('dash').classList.toggle('compact');
    $('dashSizeBtn').textContent = $('dash').classList.contains('compact') ? '+' : '−';
  });

  $('routeBtn').addEventListener('click', () => togglePanel('routePanel'));
  $('routeCloseBtn').addEventListener('click', closeRoutePanel);
  $('routePickStartBtn').addEventListener('click', () => { state.routePickMode = 'start'; setRouteStatus('Tik op de kaart voor startpunt A.'); draw(); });
  $('routePickEndBtn').addEventListener('click', () => { state.routePickMode = 'end'; setRouteStatus('Tik op de kaart voor bestemming B.'); draw(); });
  $('routeStartRow').addEventListener('click', () => $('routePickStartBtn').click());
  $('routeEndRow').addEventListener('click', () => $('routePickEndBtn').click());
  $('routeGpsBtn').addEventListener('click', () => { if (state.user) setRoutePoint('start', { lon: state.user.lon, lat: state.user.lat }); });
  $('routeCalcBtn').addEventListener('click', calculateRoute);
  $('routeOpenEditorBtn').addEventListener('click', () => {
    $('routePanel').hidden = true;
    $('editorPanel').hidden = false;
    populateBridgeSelect();
    state.editorOpen = true;
    setEditorStatus('Teken of controleer hier je eigen routes, bruggen en sluizen.');
    draw();
  });
  $('routeClearBtn').addEventListener('click', () => {
    state.routeStart = null;
    state.routeEnd = null;
    state.plannedRoute = [];
    state.routeNotices = [];
    updateRoutePanel();
    updateRouteNotices();
    setRouteStatus('Route gewist. Kies opnieuw A en B.');
    draw();
  });
  $('boatProfileBtn').addEventListener('click', () => { $('boatProfileForm').hidden = !$('boatProfileForm').hidden; });
  $('boatSaveBtn').addEventListener('click', saveBoatProfile);

  $('editorBtn').addEventListener('click', () => togglePanel('editorPanel'));
  $('editorCloseBtn').addEventListener('click', closeEditorPanel);
  $('selectModeBtn').addEventListener('click', () => setEditorMode('select'));
  $('drawRouteModeBtn').addEventListener('click', () => setEditorMode('drawRoute'));
  $('placeBridgeModeBtn').addEventListener('click', () => setEditorMode('placeBridge'));
  $('startRouteDrawBtn').addEventListener('click', startRouteDrawing);
  $('undoRoutePointBtn').addEventListener('click', undoRoutePoint);
  $('saveRouteBtn').addEventListener('click', saveRouteDraft);
  $('renameRouteBtn').addEventListener('click', renameSelectedRoute);
  $('deleteRouteBtn').addEventListener('click', deleteSelectedRoute);
  $('cancelRouteDrawBtn').addEventListener('click', cancelRouteDrawing);
  $('newBridgeBtn').addEventListener('click', newBridgeForm);
  $('pickBridgeLocationBtn').addEventListener('click', () => { state.bridgePickMode = true; setEditorMode('placeBridge'); });
  $('saveBridgeBtn').addEventListener('click', saveBridgeFromForm);
  $('deleteBridgeBtn').addEventListener('click', deleteSelectedBridge);
  $('bridgeSelect').addEventListener('change', () => {
    if ($('bridgeSelect').value) loadBridgeToForm($('bridgeSelect').value);
    else { state.selectedBridgeId = null; clearBridgeForm(); draw(); }
  });
  $('downloadGeojsonBtn').addEventListener('click', downloadNetwork);
  $('clearBrowserDataBtn').addEventListener('click', clearBrowserNetwork);
  $('importGeojsonInput').addEventListener('change', (e) => importNetworkFile(e.target.files[0]));

  $('infoBtn').addEventListener('click', () => {
    const hidden = $('infoText').hidden;
    $('infoText').hidden = !hidden;
    $('infoBtn').setAttribute('aria-expanded', String(hidden));
  });
}

async function init() {
  setupEvents();
  resize();
  loadBoatProfile();
  await loadOfflineSimpleMap();
  await loadNetwork();
  populateBridgeSelect();
  updateGpsUi();
  updateRoutePanel();
  updateMapLayerUi();
  setStatus('Offline klaar', 'Online detailkaart + lichte offline vectorkaart. Jouw routes blijven op beide kaartlagen op dezelfde GPS-positie.', 'good');
  if ('serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('service-worker.js'); } catch (err) { console.warn(err); }
  }
  draw();
}

init();
