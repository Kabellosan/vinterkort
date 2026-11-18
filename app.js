/* Vinterkort: open salting work-order PDFs, calibrate them once, show live GPS on them. */
'use strict';

const $ = (id) => document.getElementById(id);
pdfjsLib.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';

/* ---------- storage (IndexedDB, on this device only) ---------- */
const DB = (() => {
  let dbp;
  function open() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('vinterkort', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('maps', { keyPath: 'id' });
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('maps', mode);
      const s = t.objectStore('maps');
      const out = fn(s);
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : out);
      t.onerror = () => rej(t.error);
    });
  }
  return {
    all: () => tx('readonly', (s) => s.getAll()),
    get: (id) => tx('readonly', (s) => s.get(id)),
    put: (m) => tx('readwrite', (s) => { s.put(m); }),
    del: (id) => tx('readwrite', (s) => { s.delete(id); }),
  };
})();
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}

/* ---------- small UI helpers ---------- */
let toastT;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
function busy(on, msg) { $('busy').hidden = !on; if (msg) $('busy').textContent = msg; }
function show(screen) {
  for (const s of ['library', 'viewer', 'calibrate']) $(s).hidden = s !== screen;
}
let openSheetEl = null;
function openSheet(id) { closeSheet(); openSheetEl = $(id); openSheetEl.hidden = false; $('scrim').hidden = false; }
function closeSheet() { if (openSheetEl) openSheetEl.hidden = true; openSheetEl = null; $('scrim').hidden = true; }
$('scrim').onclick = closeSheet;
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeSheet));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ---------- geo math ---------- */
// Local flat projection (metres) around a reference point: fine for areas of a few km.
const R = 6371008.8, D2R = Math.PI / 180;
function toMetres(lat, lon, lat0, lon0) {
  return [(lon - lon0) * D2R * R * Math.cos(lat0 * D2R), (lat - lat0) * D2R * R];
}
function fromMetres(e, n, lat0, lon0) {
  return [lat0 + n / R / D2R, lon0 + e / (R * Math.cos(lat0 * D2R)) / D2R];
}
// Fit a similarity transform (scale + rotation + shift) from metres to PDF pixels.
// Complex form: w = a*z + b, with z = E + iN and w = x - iy (pixel y points down).
function fitCalib(pts) {
  if (pts.length < 2) return null;
  const lat0 = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon0 = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const Z = pts.map((p) => toMetres(p.lat, p.lon, lat0, lon0));
  const W = pts.map((p) => [p.x, -p.y]);
  const mz = [0, 0], mw = [0, 0];
  Z.forEach((z) => { mz[0] += z[0] / Z.length; mz[1] += z[1] / Z.length; });
  W.forEach((w) => { mw[0] += w[0] / W.length; mw[1] += w[1] / W.length; });
  let nr = 0, ni = 0, d = 0;
  for (let k = 0; k < Z.length; k++) {
    const zr = Z[k][0] - mz[0], zi = Z[k][1] - mz[1];
    const wr = W[k][0] - mw[0], wi = W[k][1] - mw[1];
    nr += zr * wr + zi * wi; ni += zr * wi - zi * wr; d += zr * zr + zi * zi;
  }
  if (d < 1) return null; // points too close together (< ~1 m apart)
  const ar = nr / d, ai = ni / d;
  const br = mw[0] - (ar * mz[0] - ai * mz[1]);
  const bi = mw[1] - (ar * mz[1] + ai * mz[0]);
  const c = { lat0, lon0, ar, ai, br, bi };
  const scale = Math.hypot(ar, ai);
  c.resid = pts.map((p) => {
    const [x, y] = geoToPx(c, p.lat, p.lon);
    return Math.hypot(x - p.x, y - p.y) / scale;
  });
  c.pxPerM = scale;
  return c;
}
function geoToPx(c, lat, lon) {
  const [e, n] = toMetres(lat, lon, c.lat0, c.lon0);
  const wr = c.ar * e - c.ai * n + c.br, wi = c.ar * n + c.ai * e + c.bi;
  return [wr, -wi];
}
function pxToGeo(c, x, y) {
  const wr = x - c.br, wi = -y - c.bi, d = c.ar * c.ar + c.ai * c.ai;
  const e = (wr * c.ar + wi * c.ai) / d, n = (wi * c.ar - wr * c.ai) / d;
  return fromMetres(e, n, c.lat0, c.lon0);
}
function distBearing(lat1, lon1, lat2, lon2) {
  const [e, n] = toMetres(lat2, lon2, lat1, lon1);
  return [Math.hypot(e, n), (Math.atan2(e, n) / D2R + 360) % 360];
}
const DIRS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const dirName = (b) => DIRS[Math.round(b / 45) % 8];
const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + ' km' : Math.round(m) + ' m');

/* ---------- PDF import ---------- */
const ADDR_RE = /([A-ZÆØÅ][A-Za-zÆØÅæøåéü.\- ]{2,40}?\s\d{1,4}[A-Za-z]?)\s*,?\s+(\d{4})\s+([A-ZÆØÅ][a-zæøå]+(?:\s[A-ZÆØÅ][a-zæøå]+)?)/;
function findAddress(text, fileName) {
  const m = text.replace(/\s+/g, ' ').match(ADDR_RE);
  if (m) return `${m[1].trim()}, ${m[2]} ${m[3]}`;
  const a = text.match(/Afdeling:\s*([^\n]+)/i);
  if (a) return a[1].trim();
  return '';
}
function niceName(fileName, address) {
  if (address) return address.slice(0, 80);
  return fileName.replace(/\.pdf$/i, '').replace(/^\d{8,}_\d+-/, '').slice(0, 80) || 'Map';
}
async function pageText(page) {
  const tc = await page.getTextContent();
  let s = '';
  for (const it of tc.items) { s += it.str; s += it.hasEOL ? '\n' : (it.str ? ' ' : ''); }
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
async function renderPage(page, maxSide = 3000) {
  const v1 = page.getViewport({ scale: 1 });
  const scale = Math.min(6, maxSide / Math.max(v1.width, v1.height));
  const vp = page.getViewport({ scale });
  const cv = document.createElement('canvas');
  cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cv.width, cv.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
  const thumb = await makeThumb(cv);
  return { blob, w: cv.width, h: cv.height, thumb };
}
async function makeThumb(src) {
  const t = document.createElement('canvas'), s = 160 / Math.max(src.width, src.height);
  t.width = Math.round(src.width * s); t.height = Math.round(src.height * s);
  t.getContext('2d').drawImage(src, 0, 0, t.width, t.height);
  return new Promise((r) => t.toBlob(r, 'image/jpeg', 0.8));
}
async function importFile(file) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const ids = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const text = await pageText(page);
    const r = await renderPage(page);
    const address = findAddress(text, file.name || '');
    const base = niceName(file.name || '', address);
    const m = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: pdf.numPages > 1 ? `${base} (page ${p})` : base,
      fileName: file.name || '', added: Date.now(),
      image: r.blob, thumb: r.thumb, w: r.w, h: r.h,
      text, address, notes: '', calib: null, pts: [],
    };
    await DB.put(m); ids.push(m.id);
  }
  return ids;
}
async function importFiles(files) {
  let ids = [];
  busy(true, 'Reading PDF…');
  try {
    for (const f of files) ids = ids.concat(await importFile(f));
  } catch (e) {
    console.error(e); toast('Could not read that PDF: ' + (e.message || e));
  } finally { busy(false); }
  await renderLibrary();
  if (ids.length === 1) openViewer(ids[0]);
  else if (ids.length) toast(`Added ${ids.length} maps`);
}
$('filePick').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) importFiles(f); };

// Files shared to the installed app (Android share sheet) arrive via the service worker.
async function checkInbox() {
  if (!('caches' in window)) return;
  try {
    const c = await caches.open('vk-inbox');
    const keys = await c.keys();
    if (!keys.length) return;
    const files = [];
    for (const k of keys) {
      const res = await c.match(k);
      const b = await res.blob();
      files.push(new File([b], decodeURIComponent(res.headers.get('x-name') || 'Shared.pdf'), { type: 'application/pdf' }));
      await c.delete(k);
    }
    history.replaceState(null, '', location.pathname);
    await importFiles(files);
  } catch (e) { console.error(e); }
}

/* ---------- library ---------- */
const urls = new Map();
function blobUrl(key, blob) {
  if (urls.has(key)) URL.revokeObjectURL(urls.get(key));
  const u = URL.createObjectURL(blob); urls.set(key, u); return u;
}
async function renderLibrary() {
  const maps = (await DB.all()).sort((a, b) => b.added - a.added);
  const list = $('mapList'); list.innerHTML = '';
  $('emptyMsg').hidden = maps.length > 0;
  for (const m of maps) {
    const b = document.createElement('button');
    b.className = 'card';
    b.innerHTML = `<img alt="" src="${blobUrl('t' + m.id, m.thumb || m.image)}"><div class="t"><div class="n">${esc(m.name)}</div>` +
      `<div class="s">${esc(m.address || m.fileName || '')}</div>` +
      (m.calib ? '<span class="pill ok">GPS ready</span>' : '<span class="pill no">Needs calibration</span>') + '</div>';
    b.onclick = () => openViewer(m.id);
    list.appendChild(b);
  }
}

/* ---------- viewer ---------- */
let cur = null;           // current map record
let vmap = null, vimg = null, meMarker = null, accCircle = null;
let follow = true, lastFix = null, heading = null, compassOn = false;
const imgLL = (m, x, y) => L.latLng(m.h - y, x); // pixel -> Leaflet simple CRS
const llImg = (m, ll) => [ll.lng, m.h - ll.lat];

function setupImageMap(el, m) {
  const map = L.map(el, { crs: L.CRS.Simple, minZoom: -5, maxZoom: 3, zoomSnap: 0.25, zoomControl: false, attributionControl: false, bounceAtZoomLimits: false });
  const b = L.latLngBounds([[0, 0], [m.h, m.w]]);
  const img = L.imageOverlay(blobUrl('i' + el.id, m.image), b).addTo(map);
  map.fitBounds(b);
  map.setMaxBounds(b.pad(0.5));
  map.setMinZoom(map.getZoom() - 1);
  return { map, img };
}

async function openViewer(id) {
  cur = await DB.get(id);
  if (!cur) return;
  show('viewer');
  $('viewTitle').textContent = cur.name;
  if (vmap) { vmap.remove(); vmap = null; }
  ({ map: vmap, img: vimg } = setupImageMap($('viewMap'), cur));
  meMarker = null; accCircle = null;
  vmap.on('dragstart', () => setFollow(false));
  setFollow(true);
  startGPS();
  updateStatus();
  if (lastFix) onFix(lastFix);
}
function closeViewer() { stopGPS(); releaseWake(); show('library'); renderLibrary(); }
$('viewBack').onclick = closeViewer;

function setFollow(on) {
  follow = on; $('fabFollow').classList.toggle('on', on);
  if (on && lastFix) onFix(lastFix);
}
$('fabFollow').onclick = () => {
  if (!cur || !cur.calib) { toast('Calibrate this map first'); return; }
  if (!lastFix) { toast('Waiting for GPS…'); return; }
  setFollow(true);
};

let watchId = null;
function startGPS() {
  if (watchId != null || !navigator.geolocation) {
    if (!navigator.geolocation) setStatus('bad', 'This browser has no GPS access.');
    return;
  }
  watchId = navigator.geolocation.watchPosition(onFix, onGpsErr, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
}
function stopGPS() { if (watchId != null) navigator.geolocation.clearWatch(watchId); watchId = null; }
function onGpsErr(e) {
  if (e.code === 1) setStatus('bad', 'Location is blocked. Allow location for this site in your phone settings.');
  else if (!lastFix) setStatus('bad', 'No GPS signal yet. Step outside or wait a moment.');
}
function onFix(pos) {
  lastFix = pos;
  if (pos.coords.heading != null && !isNaN(pos.coords.heading) && pos.coords.speed > 0.7 && !compassOn) heading = pos.coords.heading;
  if (!$('calibrate').hidden) return;
  if (!cur || !vmap) return;
  updateStatus();
  if (!cur.calib) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const [x, y] = geoToPx(cur.calib, lat, lon);
  const ll = imgLL(cur, x, y);
  const rpx = accuracy * cur.calib.pxPerM;
  if (!meMarker) {
    accCircle = L.circle(ll, { radius: rpx, color: '#1a73e8', weight: 1, fillOpacity: 0.15, interactive: false }).addTo(vmap);
    meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"><div class="cone" hidden></div><div class="core"></div></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, keyboard: false }).addTo(vmap);
  } else { meMarker.setLatLng(ll); accCircle.setLatLng(ll).setRadius(rpx); }
  drawHeading();
  const inside = x >= 0 && y >= 0 && x <= cur.w && y <= cur.h;
  if (follow && inside) vmap.panTo(ll, { animate: true });
}
function drawHeading() {
  if (!meMarker || !cur || !cur.calib) return;
  const el = meMarker.getElement(); if (!el) return;
  const cone = el.querySelector('.cone');
  if (heading == null) { cone.hidden = true; return; }
  // Map rotation: angle of geographic north on the image.
  const c = cur.calib, rot = Math.atan2(-c.ai, c.ar) / D2R; // degrees: how much north is rotated clockwise on screen
  cone.hidden = false;
  cone.style.transform = `rotate(${heading + rot}deg)`;
}
function setStatus(kind, msg, showCal) {
  const s = $('status'); s.className = 'status ' + (kind || '');
  $('statusMsg').textContent = msg; $('statusCal').hidden = !showCal;
}
function updateStatus() {
  if (!cur) return;
  if (!cur.calib) { setStatus('bad', 'Not calibrated yet. Line it up once to see your position.', true); return; }
  if (!lastFix) { setStatus('', 'Waiting for GPS…'); return; }
  const { latitude: lat, longitude: lon, accuracy } = lastFix.coords;
  const [x, y] = geoToPx(cur.calib, lat, lon);
  if (x >= 0 && y >= 0 && x <= cur.w && y <= cur.h) {
    setStatus(accuracy <= 15 ? 'good' : 'bad', `You are on this map · GPS ±${Math.round(accuracy)} m`);
  } else {
    const [clat, clon] = pxToGeo(cur.calib, cur.w / 2, cur.h / 2);
    const [d, b] = distBearing(lat, lon, clat, clon);
    setStatus('bad', `Off the map. It is ${fmtDist(d)} ${dirName(b)} of you.`);
  }
}
$('statusCal').onclick = () => openCalibrate();

/* compass (which way the phone points) */
function onOrient(e) {
  let h = null;
  if (e.webkitCompassHeading != null) h = e.webkitCompassHeading;
  else if (e.absolute && e.alpha != null) h = 360 - e.alpha;
  if (h == null) return;
  const so = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  heading = (h + so + 360) % 360;
  drawHeading();
}
$('fabCompass').onclick = async () => {
  if (compassOn) {
    compassOn = false; heading = null; drawHeading();
    window.removeEventListener('deviceorientationabsolute', onOrient); window.removeEventListener('deviceorientation', onOrient);
    $('fabCompass').classList.remove('on'); return;
  }
  try {
    if (typeof DeviceOrientationEvent !== 'undefined' && DeviceOrientationEvent.requestPermission) {
      const r = await DeviceOrientationEvent.requestPermission();
      if (r !== 'granted') { toast('Compass not allowed'); return; }
    }
  } catch (e) { toast('Compass not available'); return; }
  compassOn = true; $('fabCompass').classList.add('on');
  if ('ondeviceorientationabsolute' in window) window.addEventListener('deviceorientationabsolute', onOrient);
  else window.addEventListener('deviceorientation', onOrient);
  if (!cur || !cur.calib) toast('Calibrate the map to see your direction');
};

/* notes */
$('fabNotes').onclick = () => {
  $('notesText').value = cur.notes || '';
  $('pdfText').textContent = cur.text || '(No text in this PDF)';
  openSheet('notesSheet');
};
$('notesText').oninput = debounce(async () => { cur.notes = $('notesText').value; await DB.put(cur); }, 400);
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

/* menu */
$('viewMenu').onclick = () => {
  $('renameRow').hidden = true; $('delRow').hidden = true;
  $('mWake').textContent = 'Keep screen on: ' + (wakeLock ? 'on' : 'off');
  openSheet('menuSheet');
};
$('mCal').onclick = () => { closeSheet(); openCalibrate(); };
$('mRename').onclick = () => { $('renameRow').hidden = false; $('renameIn').value = cur.name; $('renameIn').focus(); };
$('renameOk').onclick = async () => { const v = $('renameIn').value.trim(); if (v) { cur.name = v; await DB.put(cur); $('viewTitle').textContent = v; } closeSheet(); };
$('mDelete').onclick = () => { $('delRow').hidden = false; };
$('delYes').onclick = async () => { await DB.del(cur.id); closeSheet(); cur = null; closeViewer(); toast('Map deleted'); };
$('mRotate').onclick = async () => {
  closeSheet(); busy(true, 'Rotating…');
  try {
    const bmp = await createImageBitmap(cur.image);
    const cv = document.createElement('canvas'); cv.width = cur.h; cv.height = cur.w;
    const ctx = cv.getContext('2d'); ctx.translate(cv.width, 0); ctx.rotate(Math.PI / 2); ctx.drawImage(bmp, 0, 0);
    const H = cur.h;
    cur.image = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
    cur.thumb = await makeThumb(cv);
    cur.pts = (cur.pts || []).map((p) => ({ ...p, x: H - p.y, y: p.x }));
    cur.w = cv.width; cur.h = cv.height;
    cur.calib = fitCalib(cur.pts);
    await DB.put(cur);
  } finally { busy(false); }
  openViewer(cur.id);
};
let wakeLock = null;
async function releaseWake() { try { if (wakeLock) await wakeLock.release(); } catch (e) {} wakeLock = null; }
$('mWake').onclick = async () => {
  if (wakeLock) { await releaseWake(); }
  else {
    try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => (wakeLock = null)); }
    catch (e) { toast('This phone does not allow keeping the screen on from a web page'); }
  }
  $('mWake').textContent = 'Keep screen on: ' + (wakeLock ? 'on' : 'off');
};
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && $('mWake').textContent.endsWith('on') && !wakeLock) {
    try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {}
  }
});

/* ---------- calibration ---------- */
let calA = null, calB = null, calPts = [], calMarkers = [], ghostLayer = null;
const VIBY = [56.1305, 10.1610];

async function openCalibrate() {
  show('calibrate');
  calPts = (cur.pts || []).map((p) => ({ ...p }));
  if (calA) calA.remove(); if (calB) calB.remove();
  ({ map: calA } = setupImageMap($('calA'), cur));
  calA.setMaxBounds(null);
  calB = L.map('calB', { zoomControl: false, zoomSnap: 0.5, maxZoom: 21, zoomAnimation: false });
  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
  }).addTo(calB);
  const osm = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 21, maxNativeZoom: 19, attribution: '© OpenStreetMap' });
  L.control.layers({ Satellite: sat, Streets: osm }, null, { position: 'bottomright' }).addTo(calB);
  ghostLayer = makeGhost(calB);
  if (cur.calib) {
    const [lat, lon] = pxToGeo(cur.calib, cur.w / 2, cur.h / 2);
    calB.setView([lat, lon], 18);
  } else {
    calB.setView(VIBY, 15);
    $('calQ').value = cur.address || '';
    if (cur.address) geocode(cur.address);
  }
  const others = (await DB.all()).filter((m) => m.id !== cur.id && m.calib);
  $('calCopy').hidden = others.length === 0;
  setTimeout(() => { calA.invalidateSize(); calB.invalidateSize(); }, 50);
  refreshCal();
}
function makeGhost(map) {
  const img = document.createElement('img');
  img.src = blobUrl('ghost', cur.image);
  img.style.cssText = 'position:absolute;left:0;top:0;transform-origin:0 0;pointer-events:none;opacity:0;max-width:none;width:' + cur.w + 'px;height:' + cur.h + 'px';
  map.getPanes().overlayPane.appendChild(img);
  const update = () => {
    const c = fitCalib(calPts);
    if (!c) { img.style.display = 'none'; return; }
    img.style.display = '';
    const p = (x, y) => map.latLngToLayerPoint(pxToGeo(c, x, y));
    const o = p(0, 0), px = p(cur.w, 0), py = p(0, cur.h);
    const a = (px.x - o.x) / cur.w, b = (px.y - o.y) / cur.w, cc = (py.x - o.x) / cur.h, d = (py.y - o.y) / cur.h;
    img.style.transform = `matrix(${a},${b},${cc},${d},${o.x},${o.y})`;
  };
  map.on('zoomend moveend viewreset resize', update);
  return { img, update };
}
$('ghost').oninput = () => { if (ghostLayer) ghostLayer.img.style.opacity = $('ghost').value / 100; };

function refreshCal() {
  calMarkers.forEach((m) => m.remove()); calMarkers = [];
  calPts.forEach((p, i) => {
    const icon = L.divIcon({ className: '', html: `<div class="num">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    calMarkers.push(L.marker(imgLL(cur, p.x, p.y), { icon, interactive: false }).addTo(calA));
    calMarkers.push(L.marker([p.lat, p.lon], { icon, interactive: false }).addTo(calB));
  });
  const c = fitCalib(calPts);
  let msg;
  if (!calPts.length) msg = 'No points yet. You need at least 2.';
  else if (calPts.length === 1) msg = '1 point. Add at least one more, far from the first.';
  else if (!c) msg = 'Points are too close together. Add one further away.';
  else {
    const worst = Math.max(...c.resid);
    msg = `${calPts.length} points · ` + (calPts.length === 2 ? 'add a 3rd to check accuracy' : `largest error ${worst.toFixed(1)} m` + (worst > 8 ? ' (point ' + (c.resid.indexOf(worst) + 1) + ' looks off: Undo or add more)' : ''));
  }
  $('calPts').textContent = msg;
  $('calSave').disabled = !c;
  $('calSave').style.opacity = c ? 1 : 0.4;
  $('calUndo').disabled = !calPts.length;
  $('ghostWrap').hidden = !c;
  if (c && $('ghost').value === '0') { $('ghost').value = 50; }
  if (ghostLayer) { ghostLayer.img.style.opacity = c ? $('ghost').value / 100 : 0; ghostLayer.update(); }
}
function imgCenterPx() {
  const [x, y] = llImg(cur, calA.getCenter());
  return [x, y];
}
$('calAdd').onclick = () => {
  const [x, y] = imgCenterPx();
  if (x < 0 || y < 0 || x > cur.w || y > cur.h) { toast('Put the top cross on the PDF map first'); return; }
  const g = calB.getCenter();
  calPts.push({ x, y, lat: g.lat, lon: g.lng, src: 'map' });
  refreshCal();
  toast(`Point ${calPts.length} added`, 1500);
};
$('calHere').onclick = () => {
  const [x, y] = imgCenterPx();
  if (x < 0 || y < 0 || x > cur.w || y > cur.h) { toast('Put the top cross on the PDF where you are standing'); return; }
  if (!navigator.geolocation) { toast('No GPS in this browser'); return; }
  busy(true, 'Getting an accurate GPS fix…');
  // Collect a few fixes for ~6 s and keep the most accurate one.
  let best = null; const t0 = Date.now();
  const id = navigator.geolocation.watchPosition((p) => {
    if (!best || p.coords.accuracy < best.coords.accuracy) best = p;
    if (Date.now() - t0 > 6000 || p.coords.accuracy < 4) finish();
  }, (e) => { finish(e); }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  let done = false;
  const timer = setTimeout(() => finish(), 12000);
  function finish(err) {
    if (done) return; done = true; clearTimeout(timer); navigator.geolocation.clearWatch(id); busy(false);
    if (!best) { toast(err && err.code === 1 ? 'Location is blocked for this site' : 'No GPS fix. Try again outside.'); return; }
    const { latitude: lat, longitude: lon, accuracy } = best.coords;
    calPts.push({ x, y, lat, lon, src: 'gps', acc: accuracy });
    calB.setView([lat, lon], Math.max(calB.getZoom(), 17));
    refreshCal();
    toast(`Point ${calPts.length} added (GPS ±${Math.round(accuracy)} m)`);
  }
};
$('calUndo').onclick = () => { calPts.pop(); refreshCal(); };
$('calBack').onclick = () => openViewer(cur.id);
$('calSave').onclick = async () => {
  const c = fitCalib(calPts);
  if (!c) return;
  cur.pts = calPts; cur.calib = c;
  await DB.put(cur);
  toast('Calibration saved');
  openViewer(cur.id);
};
$('calSearch').onsubmit = (e) => { e.preventDefault(); const q = $('calQ').value.trim(); if (q) geocode(q); $('calQ').blur(); };
async function geocode(q) {
  try {
    const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=dk&q=' + encodeURIComponent(q);
    const r = await fetch(u, { headers: { 'Accept-Language': 'da,en' } });
    const j = await r.json();
    if (j && j[0]) calB.setView([+j[0].lat, +j[0].lon], 18);
    else toast('Address not found. Try a nearby street.');
  } catch (e) { toast('No internet for address search. Pan the map by hand.'); }
}
$('calCopy').onclick = async () => {
  const others = (await DB.all()).filter((m) => m.id !== cur.id && m.calib);
  const list = $('copyList'); list.innerHTML = '';
  for (const m of others) {
    const b = document.createElement('button'); b.className = 'card';
    b.innerHTML = `<img alt="" src="${blobUrl('c' + m.id, m.thumb || m.image)}"><div class="t"><div class="n">${esc(m.name)}</div><div class="s">${esc(m.address || '')}</div></div>`;
    b.onclick = () => {
      const sx = cur.w / m.w, sy = cur.h / m.h;
      calPts = m.pts.map((p) => ({ ...p, x: p.x * sx, y: p.y * sy }));
      closeSheet(); refreshCal();
      const [lat, lon] = pxToGeo(fitCalib(calPts), cur.w / 2, cur.h / 2); calB.setView([lat, lon], 18);
      toast('Copied. Check with the "PDF on top" slider, then Save.');
    };
    list.appendChild(b);
  }
  openSheet('copySheet');
};

/* ---------- start ---------- */
$('btnHelp').onclick = () => openSheet('helpSheet');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
renderLibrary().then(checkInbox);

// test hooks
window.__vk = { fitCalib, geoToPx, pxToGeo, importFiles, DB, get calA() { return calA; }, get calB() { return calB; }, get cur() { return cur; }, imgLL };
