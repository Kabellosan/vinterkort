/* Vinterkort: area view. All calibrated stops near the current one, stitched together on one
   satellite map with the live GPS dot, so you can park once and walk between them. */
'use strict';

const vkArea = (() => {
  const RADIUS = 350; // metres from the current stop's centre
  let amap = null, me = null, acc = null, follow = true, layers = [];
  const cropUrls = new Map();

  // The map photo on a work order sits below the header and legend. Find that rectangle
  // (as fractions of the page) from the rows and columns that are mostly not white.
  async function mapRect(m) {
    if (m.mapRect) return m.mapRect;
    const bmp = await createImageBitmap(m.image);
    const W = 300, H = Math.round(bmp.height * W / bmp.width);
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d'); ctx.drawImage(bmp, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    const dark = (x, y) => { const i = (y * W + x) * 4; return (d[i] + d[i + 1] + d[i + 2]) / 3 < 238; };
    const rowOk = [];
    for (let y = 0; y < H; y++) { let n = 0; for (let x = 0; x < W; x++) n += dark(x, y); rowOk.push(y > H * 0.2 && n / W > 0.5); }
    let best = [0, 0], s = -1;
    for (let y = 0; y <= H; y++) {
      if (rowOk[y] && s < 0) s = y;
      if (!rowOk[y] && s >= 0) { if (y - s > best[1] - best[0]) best = [s, y]; s = -1; }
    }
    let r = { x0: 0, y0: 0, x1: 1, y1: 1 };
    if (best[1] - best[0] > H * 0.15) {
      let x0 = W, x1 = 0;
      for (let x = 0; x < W; x++) { let n = 0; for (let y = best[0]; y < best[1]; y++) n += dark(x, y); if (n / (best[1] - best[0]) > 0.5) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); } }
      if (x1 > x0) r = { x0: (x0 + 1) / W, y0: (best[0] + 1) / H, x1: (x1 - 1) / W, y1: (best[1] - 1) / H };
    }
    m.mapRect = r; await DB.put(m);
    return r;
  }
  async function cropUrl(m, r) {
    if (cropUrls.has(m.id)) return cropUrls.get(m.id);
    const bmp = await createImageBitmap(m.image);
    const sx = r.x0 * bmp.width, sy = r.y0 * bmp.height, sw = (r.x1 - r.x0) * bmp.width, sh = (r.y1 - r.y0) * bmp.height;
    const k = Math.min(1, 1600 / Math.max(sw, sh));
    const cv = document.createElement('canvas'); cv.width = Math.round(sw * k); cv.height = Math.round(sh * k);
    cv.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.85));
    const u = URL.createObjectURL(blob); cropUrls.set(m.id, u); return u;
  }

  // A PDF crop placed on the map with a CSS matrix (scale + rotation), redrawn on every move.
  function addOverlay(m, r, url, n, onTop) {
    const img = document.createElement('img');
    img.src = url; img.className = 'areaimg' + (onTop ? ' cur' : '');
    const x0 = r.x0 * m.w, y0 = r.y0 * m.h, w = (r.x1 - r.x0) * m.w, h = (r.y1 - r.y0) * m.h;
    img.style.cssText = `position:absolute;left:0;top:0;transform-origin:0 0;max-width:none;pointer-events:none;width:${w}px;height:${h}px;z-index:${onTop ? 2 : 1}`;
    amap.getPanes().overlayPane.appendChild(img);
    const label = L.marker(pxToGeo(m.calib, x0 + w / 2, y0 + h / 2), {
      icon: L.divIcon({ className: '', html: `<div class="areano${onTop ? ' cur' : ''}">${n || '•'}</div>`, iconSize: [34, 34], iconAnchor: [17, 17] }),
      keyboard: false,
    }).addTo(amap).on('click', () => openViewer(m.id));
    const update = () => {
      const p = (x, y) => amap.latLngToLayerPoint(pxToGeo(m.calib, x, y));
      const o = p(x0, y0), px = p(x0 + w, y0), py = p(x0, y0 + h);
      img.style.transform = `matrix(${(px.x - o.x) / w},${(px.y - o.y) / w},${(py.x - o.x) / h},${(py.y - o.y) / h},${o.x},${o.y})`;
    };
    update(); amap.on('zoomend moveend viewreset resize', update);
    layers.push({ img, label, update });
  }

  async function open() {
    if (!cur || !cur.calib) { toast('Calibrate this map first'); return; }
    const all = await DB.all();
    const [clat, clon] = pxToGeo(cur.calib, cur.w / 2, cur.h / 2);
    const near = all.filter((m) => m.calib && (m.id === cur.id || (() => {
      const [la, lo] = pxToGeo(m.calib, m.w / 2, m.h / 2); return distBearing(clat, clon, la, lo)[0] < RADIUS;
    })()));
    show('area');
    $('areaTitle').textContent = near.length > 1 ? `Area: ${near.length} stops` : 'Area';
    close(true);
    amap = L.map('areaMap', { zoomControl: false, zoomSnap: 0.25, maxZoom: 21, zoomAnimation: false, attributionControl: true });
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 21, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics',
    }).addTo(amap);
    amap.setView([clat, clon], 18);
    amap.on('dragstart', () => setFollow(false));
    busy(true, 'Putting the maps together…');
    try {
      const bounds = L.latLngBounds([]);
      // Other stops first, the current one last so it lies on top.
      for (const m of [...near.filter((x) => x.id !== cur.id), cur]) {
        const r = await mapRect(m);
        const url = await cropUrl(m, r);
        addOverlay(m, r, url, stopNo(all, m), m.id === cur.id);
        for (const [fx, fy] of [[r.x0, r.y0], [r.x1, r.y1], [r.x0, r.y1], [r.x1, r.y0]]) bounds.extend(pxToGeo(m.calib, fx * m.w, fy * m.h));
      }
      setTimeout(() => { amap.invalidateSize(); if (bounds.isValid()) amap.fitBounds(bounds, { padding: [20, 20] }); }, 60);
    } finally { busy(false); }
    const others = near.length - 1;
    const uncal = cur.route ? routeStops(all, cur.route).filter((m) => !m.calib).length : 0;
    toast(others ? `${others} nearby stop${others > 1 ? 's' : ''} shown. Tap a number to open it.` : 'No other calibrated stops nearby yet.' + (uncal ? ' Calibrate the neighbours and they appear here.' : ''), 4500);
    setFollow(!!lastFix);
    if (lastFix) onFix(lastFix);
  }
  function close(keepScreen) {
    layers.forEach((l) => { l.img.remove(); });
    layers = []; me = null; acc = null;
    if (amap) { amap.remove(); amap = null; }
    if (!keepScreen && cur) { show('viewer'); setTimeout(() => vmap && vmap.invalidateSize(), 50); }
  }
  function setFollow(on) { follow = on; $('areaFollow').classList.toggle('on', on); if (on && lastFix) onFix(lastFix); }
  function onFix(pos) {
    if (!amap || $('area').hidden) return;
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (!me) {
      acc = L.circle(ll, { radius: pos.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.15, interactive: false }).addTo(amap);
      me = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me"><div class="core"></div></div>', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(amap);
    } else { me.setLatLng(ll); acc.setLatLng(ll).setRadius(pos.coords.accuracy); }
    if (follow) amap.panTo(ll, { animate: true });
    $('areaStatus').textContent = `GPS ±${Math.round(pos.coords.accuracy)} m`;
  }
  $('fabArea').onclick = open;
  $('areaBack').onclick = () => close(false);
  $('areaFollow').onclick = () => { if (!lastFix) { toast('Waiting for GPS…'); return; } setFollow(true); };
  $('areaFade').oninput = () => { const v = $('areaFade').value / 100; layers.forEach((l) => (l.img.style.opacity = v)); };
  return { open, onFix, mapRect };
})();
window.vkArea = vkArea;
