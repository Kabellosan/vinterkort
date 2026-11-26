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
  for (const s of ['library', 'viewer', 'calibrate', 'area']) $(s).hidden = s !== screen;
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
// Danish address: "Bjørnholms Allé 2G, 8260 Viby J"
const ADDR_RE = /(\p{Lu}[\p{L}.'\- ]{1,40}?\s\d{1,4}\s?[A-Za-z]?\b)\s*,?\s*(\d{4})\s+(\p{Lu}\p{L}*(?:\s\p{Lu}\p{L}*)?)/u;
const fmtAddr = (m) => {
  // Drop anything glued in front of the street name ("Østjysk Bolig - VINTER Bjørnholms Allé 2G").
  const street = m[1].split(/\s{2,}|\s[-–]\s|,\s*/).pop().replace(/^(?:\p{Lu}{2,}\s+)+/u, '').trim();
  return `${street}, ${m[2]} ${m[3]}`;
};
// cells: [{s, x, y}] text pieces with page position (y grows upwards). Prefer the "Leveringsadresse" field.
function findAddress(text, cells) {
  cells = cells || text.split('\n').map((l, i) => ({ s: l, x: 0, y: -i * 20 }));
  const lab = cells.find((c) => /leverings\s*adresse|leveringssted|adresse\s*:/i.test(c.s));
  if (lab) {
    const after = lab.s.replace(/^.*?(leverings\s*adresse|leveringssted|adresse)\s*:?/i, '').trim();
    const below = cells.filter((c) => c !== lab && c.x > lab.x - 40 && c.x < lab.x + 300 && c.y < lab.y && c.y > lab.y - 45)
      .sort((a, b) => b.y - a.y || a.x - b.x).map((c) => c.s);
    const cand = [after, ...below].filter(Boolean).join('  ').trim();
    const m = cand.match(ADDR_RE);
    if (m) return fmtAddr(m);
    if (/\d/.test(cand)) return cand.slice(0, 80);
  }
  for (const c of cells) { const m = c.s.match(ADDR_RE); if (m && !/vagt|tlf|telefon/i.test(m[0])) return fmtAddr(m); }
  const a = text.match(/Afdeling:\s*([^\n]+)/i);
  if (a) return a[1].trim();
  return '';
}
function niceName(fileName, address) {
  if (address) return address.slice(0, 80);
  return fileName.replace(/\.pdf$/i, '').replace(/^(\d{8,}_)?\d+-/, '').slice(0, 80) || 'Map';
}
// Rebuild the page's text as lines and cells (pieces separated by a wide gap), using positions.
async function pageText(page) {
  const tc = await page.getTextContent();
  const items = tc.items.filter((it) => it.str && it.str.trim() && Math.abs(it.transform[1]) < 0.01)
    .map((it) => ({ s: it.str.normalize('NFC'), x: it.transform[4], y: it.transform[5], w: it.width }));
  // Word puts many fields (customer, address, notes on the map) in text annotations, not the page text.
  try {
    for (const an of await page.getAnnotations()) {
      const str = (an.contentsObj && an.contentsObj.str) || (typeof an.contents === 'string' ? an.contents : '') || (an.fieldValue && typeof an.fieldValue === 'string' ? an.fieldValue : '');
      if (!str || !str.trim() || !an.rect) continue;
      const lns = str.normalize('NFC').split(/\r\n|\r|\n/).map((l) => l.trim());
      lns.forEach((l, i) => { if (l) items.push({ s: l, x: an.rect[0], y: an.rect[3] - 4 - i * 12, w: 1000, annot: true }); });
    }
  } catch (e) {}
  items.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of items) {
    const ln = lines.find((l) => Math.abs(l.y - it.y) < 3);
    if (ln) ln.items.push(it); else lines.push({ y: it.y, items: [it] });
  }
  const cells = [];
  const out = [];
  for (const ln of lines.sort((a, b) => b.y - a.y)) {
    ln.items.sort((a, b) => a.x - b.x);
    let cur = null; const parts = [];
    for (const it of ln.items) {
      if (cur && !it.annot && !cur.annot && it.x - (cur.x + cur.w) < 12) { cur.s += (it.x - (cur.x + cur.w) > 1.5 ? ' ' : '') + it.s; cur.w = it.x + it.w - cur.x; }
      else { cur = { ...it }; parts.push(cur); }
    }
    parts.forEach((p) => { p.s = p.s.replace(/\s+/g, ' ').trim(); cells.push(p); });
    out.push(parts.map((p) => p.s).join('    '));
  }
  // Rotated text (sideways pages) is kept too, in reading order from pdf.js.
  const rot = tc.items.filter((it) => it.str && it.str.trim() && Math.abs(it.transform[1]) >= 0.01).map((it) => it.str.normalize('NFC'));
  const text = (out.join('\n') + (rot.length ? '\n\n' + rot.join(' ') : '')).trim();
  return { text, cells };
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
async function importFile(file, route, orderStart, extra) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const ids = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const { text, cells } = await pageText(page);
    const r = await renderPage(page);
    const address = findAddress(text, cells);
    const base = niceName(file.name || '', address);
    const m = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      name: pdf.numPages > 1 ? `${base} (page ${p})` : base,
      fileName: file.name || '', added: Date.now(),
      image: r.blob, thumb: r.thumb, w: r.w, h: r.h,
      text, address, notes: '', calib: null, pts: [],
      route: route || '', order: (orderStart || 0) + ids.length,
      ...(extra || {}), page: p,
    };
    await DB.put(m); ids.push(m.id);
  }
  return ids;
}
async function importFiles(files, route) {
  let ids = [];
  files = [...files].sort((a, b) => (a.name || '').localeCompare(b.name || '', 'da', { numeric: true }));
  let start = 0;
  if (route) start = (await DB.all()).filter((m) => m.route === route).reduce((mx, m) => Math.max(mx, (m.order || 0) + 1), 0);
  try {
    for (let i = 0; i < files.length; i++) {
      busy(true, files.length > 1 ? `Reading PDF ${i + 1} of ${files.length}…` : 'Reading PDF…');
      ids = ids.concat(await importFile(files[i], route, start + ids.length));
    }
  } catch (e) {
    console.error(e); toast('Could not read that PDF: ' + (e.message || e));
  } finally { busy(false); }
  await renderLibrary();
  if (ids.length === 1 && !route) openViewer(ids[0]);
  else if (ids.length) toast(`Added ${ids.length} map${ids.length > 1 ? 's' : ''}` + (route ? ` to ${route}` : ''));
}
let pickRoute = '';
$('filePick').onchange = (e) => { const f = [...e.target.files]; e.target.value = ''; const r = pickRoute; pickRoute = ''; if (f.length) importFiles(f, r); };
function pickInto(route) { pickRoute = route || ''; $('filePick').click(); }
$('btnAddLoose').onclick = () => pickInto('');

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
let editRoute = null; // route name whose order is being edited
function routeStops(maps, route) {
  return maps.filter((m) => (m.route || '') === route).sort((a, b) => (a.order || 0) - (b.order || 0) || a.added - b.added);
}
function stopNo(maps, m) { return m.route ? routeStops(maps, m.route).indexOf(m) + 1 : 0; }
async function renderLibrary() {
  const maps = await DB.all();
  const list = $('mapList'); list.innerHTML = '';
  $('emptyMsg').hidden = maps.length > 0;
  const routes = [...new Set(maps.filter((m) => m.route).map((m) => m.route))].sort((a, b) => a.localeCompare(b, 'da'));
  const groups = routes.map((r) => [r, routeStops(maps, r)]);
  const loose = maps.filter((m) => !m.route).sort((a, b) => b.added - a.added);
  if (loose.length) groups.push(['', loose]);
  for (const [route, items] of groups) {
    const sec = document.createElement('section'); sec.className = 'group';
    const ready = items.filter((m) => m.calib).length;
    const editing = route && editRoute === route;
    const h = document.createElement('div'); h.className = 'ghead';
    h.innerHTML = `<div class="gt"><div class="gn">${route ? esc(route) : 'Other maps'}</div><div class="s">${items.length} map${items.length === 1 ? '' : 's'} · ${ready} GPS ready</div></div>`;
    if (route) {
      const add = document.createElement('button'); add.className = 'btn secondary sm'; add.textContent = '+ PDFs'; add.onclick = () => pickInto(route);
      const ord = document.createElement('button'); ord.className = 'btn secondary sm'; ord.textContent = editing ? 'Done' : 'Edit';
      ord.onclick = () => { editRoute = editing ? null : route; renderLibrary(); };
      h.append(add, ord);
    }
    sec.appendChild(h);
    if (editing) {
      const rr = document.createElement('div'); rr.className = 'editbar';
      rr.innerHTML = `<input id="routeName" value="${esc(route)}" aria-label="Route name"><button class="btn sm" id="routeRename">Rename</button>`;
      sec.appendChild(rr);
      rr.querySelector('#routeRename').onclick = async () => {
        const v = rr.querySelector('#routeName').value.trim(); if (!v || v === route) return;
        for (const m of items) { m.route = v; await DB.put(m); }
        editRoute = v; renderLibrary();
      };
      const sb = document.createElement('div'); sb.className = 'editbar';
      sb.innerHTML = '<button class="btn secondary sm" style="flex:1">Sort by location</button>';
      sb.firstChild.onclick = () => sortByLocation(items);
      sec.appendChild(sb);
      const hint = document.createElement('p'); hint.className = 'calhelp'; hint.textContent = 'Sort by location puts each stop next to the nearest one, starting from where you are (or stop 1). Fine-tune with the arrows to match Skyhost. ✕ deletes a map (tap twice).'; sec.appendChild(hint);
    }
    items.forEach((m, i) => {
      const row = document.createElement('div'); row.className = 'row1';
      const b = document.createElement('button');
      b.className = 'card';
      b.innerHTML = (route ? `<span class="stopno">${i + 1}</span>` : '') +
        `<img alt="" src="${blobUrl('t' + m.id, m.thumb || m.image)}"><div class="t"><div class="n">${esc(m.name)}</div>` +
        `<div class="s">${esc(m.address && m.address !== m.name ? m.address : m.fileName || '')}</div>` +
        (m.calib ? (m.calibFrom === 'claude' ? '<span class="pill no">First guess: check it</span>' : '<span class="pill ok">GPS ready</span>') : '<span class="pill no">Needs calibration</span>') + '</div>';
      b.onclick = () => openViewer(m.id);
      row.appendChild(b);
      if (editing) {
        const mk = (label, aria, fn, dis) => { const x = document.createElement('button'); x.className = 'iconbtn mv'; x.textContent = label; x.setAttribute('aria-label', aria); x.disabled = dis; x.onclick = fn; return x; };
        const swap = async (j) => { const a = items[i], c = items[j]; items[i] = c; items[j] = a; await saveOrder(items); };
        const col = document.createElement('div'); col.className = 'mvcol';
        col.append(mk('▲', 'Move up', () => swap(i - 1), i === 0), mk('▼', 'Move down', () => swap(i + 1), i === items.length - 1));
        const del = document.createElement('button'); del.className = 'iconbtn delbtn'; del.textContent = '✕'; del.setAttribute('aria-label', 'Delete ' + m.name);
        del.onclick = async () => {
          if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Delete?'; setTimeout(() => { del.classList.remove('armed'); del.textContent = '✕'; }, 3000); return; }
          await deleteMap(m); toast('Deleted ' + m.name); renderLibrary();
        };
        row.append(col, del);
      }
      sec.appendChild(row);
    });
    list.appendChild(sec);
  }
  updateHere(maps);
}
// Deleting a map also remembers its Drive file, so the next Drive sync doesn't bring it back.
async function deleteMap(m) {
  await DB.del(m.id);
  if (m.driveId) {
    try { const d = JSON.parse(localStorage.getItem('vk-deleted') || '[]'); d.push(m.driveId); localStorage.setItem('vk-deleted', JSON.stringify(d.slice(-500))); } catch (e) {}
  }
}
// Where a map is: its calibration centre, else the address position from Drive (approx).
function mapPos(m) {
  if (m.calib) return pxToGeo(m.calib, m.w / 2, m.h / 2);
  if (m.approx && m.approx.lat) return [m.approx.lat, m.approx.lon];
  return null;
}
async function sortByLocation(items) {
  const known = items.filter((m) => mapPos(m)), unknown = items.filter((m) => !mapPos(m));
  if (known.length < 2) { toast('Not enough maps with a known location yet. Calibrate some, or sync from Drive.'); return; }
  let here = lastFix ? [lastFix.coords.latitude, lastFix.coords.longitude] : mapPos(known[0]);
  const left = [...known], out = [];
  while (left.length) {
    let bi = 0, bd = Infinity;
    left.forEach((m, i) => { const [la, lo] = mapPos(m); const d = distBearing(here[0], here[1], la, lo)[0]; if (d < bd) { bd = d; bi = i; } });
    const m = left.splice(bi, 1)[0]; out.push(m); here = mapPos(m);
  }
  await saveOrder([...out, ...unknown]);
  toast(unknown.length ? `Sorted. ${unknown.length} map${unknown.length > 1 ? 's' : ''} without a location went to the end.` : 'Sorted by location');
}
async function saveOrder(items) {
  for (let k = 0; k < items.length; k++) { items[k].order = k; await DB.put(items[k]); }
  renderLibrary();
}
$('btnNewRoute').onclick = () => { $('newRouteName').value = ''; openSheet('routeSheet'); setTimeout(() => $('newRouteName').focus(), 50); };
$('newRouteForm').onsubmit = (e) => {
  e.preventDefault();
  const v = $('newRouteName').value.trim(); if (!v) return;
  closeSheet(); pickInto(v);
};

/* Which calibrated map is the person standing in? Prefers the one whose centre is closest. */
function mapAt(maps, lat, lon) {
  let best = null, bestD = Infinity;
  for (const m of maps) {
    if (!m.calib) continue;
    const [x, y] = geoToPx(m.calib, lat, lon);
    if (x < 0 || y < 0 || x > m.w || y > m.h) continue;
    const d = Math.hypot(x - m.w / 2, y - m.h / 2) / m.calib.pxPerM;
    if (d < bestD) { bestD = d; best = m; }
  }
  return best;
}
let libMaps = [];
function updateHere(maps) {
  if (maps) libMaps = maps;
  const el = $('hereCard');
  if (!lastFix || $('library').hidden) { el.hidden = true; return; }
  const m = mapAt(libMaps, lastFix.coords.latitude, lastFix.coords.longitude);
  if (!m) { el.hidden = true; return; }
  const n = stopNo(libMaps, m);
  $('hereText').textContent = (n ? `#${n} ` : '') + m.name;
  el.onclick = () => openViewer(m.id);
  el.hidden = false;
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
  const all = await DB.all(); libMaps = all;
  const stops = cur.route ? routeStops(all, cur.route) : [];
  const idx = stops.findIndex((m) => m.id === cur.id);
  $('viewTitle').textContent = (idx >= 0 ? `#${idx + 1} ` : '') + cur.name;
  $('viewPrev').hidden = $('viewNext').hidden = idx < 0;
  $('viewPrev').disabled = idx <= 0; $('viewNext').disabled = idx < 0 || idx >= stops.length - 1;
  $('viewPrev').onclick = () => idx > 0 && openViewer(stops[idx - 1].id);
  $('viewNext').onclick = () => idx < stops.length - 1 && openViewer(stops[idx + 1].id);
  if (vmap) { vmap.remove(); vmap = null; }
  ({ map: vmap, img: vimg } = setupImageMap($('viewMap'), cur));
  meMarker = null; accCircle = null;
  vmap.on('dragstart', () => setFollow(false));
  setFollow(true);
  startGPS();
  updateStatus();
  showNotesBanner();
  if (lastFix) onFix(lastFix);
}
function closeViewer() { releaseWake(); cur = null; show('library'); renderLibrary(); }
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
  if (window.vkArea) vkArea.onFix(pos);
  if (pos.coords.heading != null && !isNaN(pos.coords.heading) && pos.coords.speed > 0.7 && !compassOn) heading = pos.coords.heading;
  if (!$('calibrate').hidden) return;
  if (!$('library').hidden) { updateHere(); return; }
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
let statusAction = null;
function setStatus(kind, msg, action, label) {
  const s = $('status'); s.className = 'status ' + (kind || '');
  $('statusMsg').textContent = msg;
  if (action === true) { action = () => openCalibrate(); label = label || 'Calibrate'; }
  statusAction = action || null;
  $('statusCal').hidden = !action; if (action) $('statusCal').textContent = label;
}
function updateStatus() {
  if (!cur) return;
  if (!cur.calib) { setStatus('bad', 'Not calibrated yet. Line it up once to see your position.', true); return; }
  if (!lastFix) { setStatus('', 'Waiting for GPS…'); return; }
  const { latitude: lat, longitude: lon, accuracy } = lastFix.coords;
  const [x, y] = geoToPx(cur.calib, lat, lon);
  if (x >= 0 && y >= 0 && x <= cur.w && y <= cur.h) {
    if (cur.calibFrom === 'claude') setStatus('bad', `On this map · GPS ±${Math.round(accuracy)} m · first guess, check the dot`, true, 'Fix');
    else setStatus(accuracy <= 15 ? 'good' : 'bad', `You are on this map · GPS ±${Math.round(accuracy)} m`);
  } else {
    const other = mapAt(libMaps.filter((m) => m.id !== cur.id), lat, lon);
    if (other) {
      const n = stopNo(libMaps, other);
      setStatus('bad', `You're at ${n ? '#' + n + ' ' : ''}${other.name}`, () => openViewer(other.id), 'Open');
      return;
    }
    const [clat, clon] = pxToGeo(cur.calib, cur.w / 2, cur.h / 2);
    const [d, b] = distBearing(lat, lon, clat, clon);
    setStatus('bad', `Off the map. It is ${fmtDist(d)} ${dirName(b)} of you.`);
  }
}
$('statusCal').onclick = () => statusAction && statusAction();

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
// Hand-written hints on the work order (key box codes, "remember the stairwell"…): everything in the PDF's
// text except the standard header and colour legend.
const LEGEND_RE = /^=|hånd\b|kompakttraktor|centrifugal|stor traktor|skellinje|indgange|døre\/porte|teknisk udstyr|elstander|belægning som|^(kunde|leveringsadresse|leveringssted)\b/i;
function pdfNotes(m) {
  const lines = String(m.text || '').split('\n');
  const out = [];
  const ki = lines.findIndex((l) => /^\s*kunde\s*:/i.test(l));
  const customer = ki >= 0 && lines[ki + 1] ? lines[ki + 1].split(/\s{3,}/)[0].trim() : '';
  const street = (m.address || '').split(',')[0].trim().toLowerCase();
  for (const l of lines) for (let c of l.split(/\s{3,}/)) {
    c = c.trim();
    if (!c || c.length < 3 || LEGEND_RE.test(c)) continue;
    if (customer && c === customer) continue;
    if (street && c.toLowerCase().includes(street)) continue;
    if (/^[\d\s.,-]+$/.test(c)) continue; // stray numbers
    out.push(c);
  }
  return [...new Set(out)];
}
const notesSeen = new Set();
function showNotesBanner() {
  const el = $('notesBanner');
  const lines = pdfNotes(cur);
  const mine = (cur.notes || '').trim();
  if ((!lines.length && !mine) || notesSeen.has(cur.id)) { el.hidden = true; return; }
  $('notesBannerText').innerHTML = (mine ? `<div><b>${esc(mine)}</b></div>` : '') + lines.map((l) => `<div>${esc(l)}</div>`).join('');
  el.hidden = false;
}
$('notesBannerClose').onclick = (e) => { e.stopPropagation(); notesSeen.add(cur.id); $('notesBanner').hidden = true; };
$('notesBanner').onclick = () => $('fabNotes').click();
$('fabNotes').onclick = () => {
  $('notesText').value = cur.notes || '';
  const hints = pdfNotes(cur);
  $('pdfText').textContent = (hints.length ? hints.join('\n') + '\n\n— All text in the PDF —\n' : '') + (cur.text || '(No text in this PDF)');
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
$('renameOk').onclick = async () => { const v = $('renameIn').value.trim(); if (v) { cur.name = v; cur.nameFrom = 'me'; await DB.put(cur); $('viewTitle').textContent = v; } closeSheet(); };
$('mDelete').onclick = () => { $('delRow').hidden = false; };
$('delYes').onclick = async () => { await deleteMap(cur); closeSheet(); cur = null; closeViewer(); toast('Map deleted'); };
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
    // Start near another calibrated stop on the same route, else Viby.
    const sib = (await DB.all()).filter((m) => m.calib && m.route && m.route === cur.route);
    if (sib.length) { const s0 = sib[0]; calB.setView(pxToGeo(s0.calib, s0.w / 2, s0.h / 2), 15); }
    else calB.setView(VIBY, 15);
    const q = cur.address || findAddress(cur.text || '') || addressFromFileName(cur.fileName || '');
    $('calQ').value = q;
    if (!q) toast('No address found in this PDF. Search for it, or pan the map by hand.', 4000);
  }
  const others = (await DB.all()).filter((m) => m.id !== cur.id && m.calib);
  $('calCopy').hidden = others.length === 0;
  fit = null;
  // New maps and first guesses start in drag-to-fit; maps you calibrated with points open in point mode.
  const pointMode = cur.calib && cur.calibFrom !== 'claude' && (cur.pts || []).some((p) => p.src !== 'fit');
  setFitMode(!pointMode);
  setTimeout(() => { calA.invalidateSize(); calB.invalidateSize(); }, 50);
  refreshCal();
  if (!cur.calib && $('calQ').value) geocode($('calQ').value);
}

// The address search moved the map: bring an untouched PDF along, sized to the new view.
function onGeocoded() { if (fitMode && !fitTouched) { fit = null; calPts = []; initFit(); } }

/* ---------- drag to fit: move, pinch and twist the PDF on top of the satellite map ---------- */
// fit = { lat, lon, s (metres per PDF pixel), th (radians, clockwise) } for the PDF's centre.
let fit = null, fitMode = false, fitTouched = false, fitMoveMap = false;
function fitToPts(f) {
  const out = [];
  for (const [x, y] of [[0, 0], [cur.w, 0], [cur.w, cur.h], [0, cur.h]]) {
    const dx = x - cur.w / 2, dy = y - cur.h / 2;
    const e = f.s * (dx * Math.cos(f.th) - dy * Math.sin(f.th));
    const so = f.s * (dx * Math.sin(f.th) + dy * Math.cos(f.th));
    const [lat, lon] = fromMetres(e, -so, f.lat, f.lon);
    out.push({ x, y, lat, lon, src: 'fit' });
  }
  return out;
}
function initFit() {
  const c = fitCalib(calPts);
  if (c) {
    const [lat, lon] = pxToGeo(c, cur.w / 2, cur.h / 2);
    const [la2, lo2] = pxToGeo(c, cur.w / 2 + 100, cur.h / 2);
    const [e, n] = toMetres(la2, lo2, lat, lon);
    fit = { lat, lon, s: Math.hypot(e, n) / 100, th: Math.atan2(-n, e) };
  } else {
    // Centre of the map view, PDF about 70% of the view wide, north up.
    const g = calB.getCenter(), sz = calB.getSize();
    const mPerScreenPx = 40075016.686 * Math.cos(g.lat * D2R) / (256 * Math.pow(2, calB.getZoom()));
    fit = { lat: g.lat, lon: g.lng, s: (sz.x * 0.7 * mPerScreenPx) / cur.w, th: 0 };
  }
  applyFit(true);
}
function applyFit(full) {
  calPts = fitToPts(fit);
  if (full) refreshCal(); else if (ghostLayer) ghostLayer.update();
}
function setFitMode(on) {
  fitMode = on; fitTouched = false;
  $('calibrate').classList.toggle('fitting', on);
  $('calFitToggle').textContent = on ? 'Use points' : 'Drag to fit';
  setFitMoveMap(false);
  if (on) {
    $('ghost').value = Math.max(+$('ghost').value || 0, 55);
    setTimeout(() => { calB.invalidateSize(); if (!fit) initFit(); else applyFit(true); }, 60);
  } else {
    setTimeout(() => { calA.invalidateSize(); calB.invalidateSize(); refreshCal(); }, 60);
  }
}
function setFitMoveMap(on) {
  fitMoveMap = on;
  $('fitLayer').style.pointerEvents = on ? 'none' : 'auto';
  $('fitMovePdf').classList.toggle('on', !on); $('fitMoveMap').classList.toggle('on', on);
}
$('calFitToggle').onclick = () => setFitMode(!fitMode);
$('fitMovePdf').onclick = () => setFitMoveMap(false);
$('fitMoveMap').onclick = () => setFitMoveMap(true);
$('fitRotL').onclick = () => { if (!fit) return; fit.th -= 1 * D2R; fitTouched = true; applyFit(true); };
$('fitRotR').onclick = () => { if (!fit) return; fit.th += 1 * D2R; fitTouched = true; applyFit(true); };
(() => {
  const ptrs = new Map(); let start = null;
  const layer = $('fitLayer');
  const pos = (e) => { const r = layer.getBoundingClientRect(); return L.point(e.clientX - r.left, e.clientY - r.top); };
  function snapshot() {
    const ps = [...ptrs.values()];
    const c = calB.latLngToContainerPoint([fit.lat, fit.lon]);
    const mid = ps.length > 1 ? ps[0].add(ps[1]).divideBy(2) : ps[0];
    const d = ps.length > 1 ? ps[1].subtract(ps[0]) : null;
    return { c, mid, dist: d ? Math.hypot(d.x, d.y) : 0, ang: d ? Math.atan2(d.y, d.x) : 0, s: fit.s, th: fit.th, n: ps.length };
  }
  layer.addEventListener('pointerdown', (e) => {
    if (!fit) return;
    layer.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, pos(e)); start = snapshot(); e.preventDefault();
  });
  layer.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId) || !start) return;
    ptrs.set(e.pointerId, pos(e));
    const now = snapshot(); if (now.n !== start.n) { start = now; return; }
    let k = 1, da = 0;
    if (now.n > 1 && start.dist > 10) { k = now.dist / start.dist; da = now.ang - start.ang; }
    // Keep the PDF point under the fingers' midpoint under it: C' = M' + R(da)·k·(C − M)
    const v = start.c.subtract(start.mid);
    const rv = L.point(v.x * Math.cos(da) - v.y * Math.sin(da), v.x * Math.sin(da) + v.y * Math.cos(da)).multiplyBy(k);
    const ll = calB.containerPointToLatLng(now.mid.add(rv));
    fit.lat = ll.lat; fit.lon = ll.lng; fit.s = start.s / k; fit.th = start.th + da;
    fitTouched = true; applyFit(false);
  });
  const end = (e) => { if (!ptrs.delete(e.pointerId)) return; start = ptrs.size ? snapshot() : null; if (!ptrs.size && fit) applyFit(true); };
  layer.addEventListener('pointerup', end); layer.addEventListener('pointercancel', end);
  // Mouse wheel / trackpad: zoom the PDF around the cursor (desktop).
  layer.addEventListener('wheel', (e) => {
    if (!fit) return; e.preventDefault();
    const k = Math.exp(-e.deltaY / 500), m = pos(e), c = calB.latLngToContainerPoint([fit.lat, fit.lon]);
    const ll = calB.containerPointToLatLng(m.add(c.subtract(m).multiplyBy(k)));
    fit.lat = ll.lat; fit.lon = ll.lng; fit.s /= k; fitTouched = true; applyFit(true);
  }, { passive: false });
})();
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
    if (p.src === 'fit') return;
    const icon = L.divIcon({ className: '', html: `<div class="num">${i + 1}</div>`, iconSize: [24, 24], iconAnchor: [12, 12] });
    calMarkers.push(L.marker(imgLL(cur, p.x, p.y), { icon, interactive: false }).addTo(calA));
    calMarkers.push(L.marker([p.lat, p.lon], { icon, interactive: false }).addTo(calB));
  });
  const c = fitCalib(calPts);
  let msg;
  if (fitMode) msg = fitTouched ? 'Looks right? Tap Save. Tip: use “Move map” to look around.' : 'Drag the PDF onto the right spot. Pinch to resize, twist to turn.';
  else if (calPts.length && calPts.every((p) => p.src === 'fit')) msg = 'Lined up by dragging. Add points to fine-tune, or Save.';
  else if (!calPts.length) msg = 'No points yet. You need at least 2.';
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
  if (calPts.filter((p) => p.src !== 'fit').length >= 2) calPts = calPts.filter((p) => p.src !== 'fit');
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
    if (calPts.filter((p) => p.src !== 'fit').length >= 2) calPts = calPts.filter((p) => p.src !== 'fit');
    calB.setView([lat, lon], Math.max(calB.getZoom(), 17));
    refreshCal();
    toast(`Point ${calPts.length} added (GPS ±${Math.round(accuracy)} m)`);
  }
};
$('calUndo').onclick = () => { if (fitMode) { fit = null; initFit(); fitTouched = false; refreshCal(); return; } calPts.pop(); refreshCal(); };
$('calBack').onclick = () => openViewer(cur.id);
$('calSave').onclick = async () => {
  const c = fitCalib(calPts);
  if (!c) return;
  cur.pts = calPts; cur.calib = c; cur.calibFrom = 'me'; cur.calibDirty = true;
  await DB.put(cur);
  if (window.vkDrive) vkDrive.pushSoon(cur);
  toast('Calibration saved');
  openViewer(cur.id);
};
$('calSearch').onsubmit = (e) => {
  e.preventDefault(); const q = $('calQ').value.trim(); $('calQ').blur();
  // In drag-to-fit, bring the PDF along to the place that was found.
  if (q) geocode(q).then((ok) => { if (ok && fitMode && fit) { const g = calB.getCenter(); fit.lat = g.lat; fit.lon = g.lng; applyFit(true); } });
};
// Try a few spellings of the address, preferring results around Aarhus.
async function geocode(q) {
  const variants = [q];
  const noCity = q.replace(/(\d{4})\s+\D+$/, '$1').trim();
  if (noCity !== q) variants.push(noCity);
  const street = q.split(',')[0].trim();
  if (street !== q) { variants.push(street + ', Aarhus'); variants.push(street); }
  try {
    // Danish address register first (exact for Danish addresses), then OpenStreetMap.
    try {
      const r = await fetch('https://api.dataforsyningen.dk/adgangsadresser/autocomplete?per_side=1&q=' + encodeURIComponent(q));
      const j = r.ok ? await r.json() : [];
      const h = j && j[0], d = h && (h.adgangsadresse || h.data);
      if (d && d.x && d.y) {
        calB.setView([d.y, d.x], 18); onGeocoded();
        toast('Found: ' + (h.tekst || q), 4000);
        return true;
      }
    } catch (e) {}
    for (const v of variants) {
      const u = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=dk&viewbox=9.95,56.25,10.35,56.05&q=' + encodeURIComponent(v);
      const r = await fetch(u, { headers: { 'Accept-Language': 'da,en' } });
      const j = await r.json();
      if (j && j[0]) {
        calB.setView([+j[0].lat, +j[0].lon], 18); onGeocoded();
        toast('Found: ' + j[0].display_name.split(',').slice(0, 3).join(','), 4000);
        return true;
      }
    }
    toast('Address not found. Try a street name nearby, or pan the map by hand.', 4000);
  } catch (e) { toast('Address search needs internet. Pan the map by hand.'); }
  return false;
}
// Work orders from Skyhost often have the address squashed into the file name, e.g. "stensagervej11-udskolingen.pdf".
function addressFromFileName(fn) {
  const m = fn.toLowerCase().match(/([a-zæøå]{3,}(?:vej|gade|allé|alle|vænget|parken|torv|plads|stien|boulevard|toften|haven|bakken|høj|centret|centeret|stræde))(\d{1,7}(?:[a-z](?![a-zæøå]))?)?/);
  if (!m) return '';
  let name = m[1][0].toUpperCase() + m[1].slice(1), num = m[2] || '', post = '';
  if (/^\d{5,7}$/.test(num)) { post = num.slice(-4); num = num.slice(0, -4); }
  return (name + (num ? ' ' + num : '') + (post ? ', ' + post : '')).trim();
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
      closeSheet(); fit = null; if (fitMode) initFit(); refreshCal();
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
renderLibrary().then(() => { if (libMaps.some((m) => m.calib)) startGPS(); }).then(checkInbox);

// test hooks
window.__vk = { fitCalib, geoToPx, pxToGeo, importFiles, DB, get calA() { return calA; }, get calB() { return calB; }, get cur() { return cur; }, imgLL };
