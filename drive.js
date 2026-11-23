/* Vinterkort: sync work-order PDFs and calibrations with a Google Drive folder.
   One Drive folder = one route. The app imports new PDFs from it and keeps calibrations in
   vinterkort-calibrations.json in the same folder (written by the app). Claude can drop first-guess
   calibrations in vinterkort-claude-calibrations.json; the app's own calibrations win. */
'use strict';

const vkDrive = (() => {
  const CLIENT_ID = '97554383154-ft137agrq4ub4c0ju25v0jolvhf5k0sl.apps.googleusercontent.com';
  const SCOPES = 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.file';
  const API = 'https://www.googleapis.com/drive/v3';
  const APP_FILE = 'vinterkort-calibrations.json';
  const CLAUDE_FILE = 'vinterkort-claude-calibrations.json';
  let token = null, tokenExp = 0, tokenClient = null, gisP = null;

  /* ---- sign-in (Google Identity Services, token flow; nothing stored on a server) ---- */
  function loadGis() {
    if (window.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
    if (!gisP) gisP = new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
      s.onload = res; s.onerror = () => { gisP = null; rej(new Error('Could not reach Google. Check your internet.')); };
      document.head.appendChild(s);
    });
    return gisP;
  }
  const haveToken = () => token && Date.now() < tokenExp - 60000;
  async function getToken() {
    if (haveToken()) return token;
    await loadGis();
    return new Promise((res, rej) => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CLIENT_ID, scope: SCOPES,
        login_hint: localStorage.getItem('vk-drive-email') || undefined,
        callback: (r) => {
          if (r.error) { rej(new Error(r.error_description || r.error)); return; }
          token = r.access_token; tokenExp = Date.now() + (r.expires_in || 3600) * 1000; res(token);
        },
        error_callback: (e) => rej(new Error(e && e.type === 'popup_closed' ? 'Sign-in was closed' : (e && e.message) || 'Sign-in failed')),
      });
      tokenClient.requestAccessToken({ prompt: localStorage.getItem('vk-drive-ok') ? '' : 'consent' });
    }).then((t) => { try { localStorage.setItem('vk-drive-ok', '1'); } catch (e) {} return t; });
  }
  async function api(path, opts = {}) {
    const t = await getToken();
    const r = await fetch(path.startsWith('http') ? path : API + path, { ...opts, headers: { Authorization: 'Bearer ' + t, ...(opts.headers || {}) } });
    if (r.status === 401) { token = null; throw new Error('Google sign-in expired. Tap Drive again.'); }
    if (!r.ok) throw new Error('Drive said ' + r.status + ': ' + (await r.text()).slice(0, 160));
    return r;
  }
  const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  async function list(query, fields = 'files(id,name,mimeType,modifiedTime,size)', order = 'name') {
    const out = []; let page = '';
    do {
      const u = `/files?q=${encodeURIComponent(query)}&fields=nextPageToken,${encodeURIComponent(fields)}&pageSize=200&orderBy=${encodeURIComponent(order)}&supportsAllDrives=true&includeItemsFromAllDrives=true` + (page ? '&pageToken=' + page : '');
      const j = await (await api(u)).json();
      out.push(...(j.files || [])); page = j.nextPageToken || '';
    } while (page);
    return out;
  }

  /* ---- calibration files ---- */
  const norm = (s) => String(s || '').toLowerCase().normalize('NFC').replace(/\.pdf$/, '').replace(/^\d{8,}_\d+-/, '').replace(/[^a-z0-9æøå]/g, '');
  async function readJson(folderId, name) {
    const f = (await list(`${q(folderId)} in parents and name = ${q(name)} and trashed = false`, 'files(id,name,modifiedTime)', 'modifiedTime desc'))[0];
    if (!f) return { file: null, data: { version: 1, maps: [] } };
    try { const data = await (await api(`/files/${f.id}?alt=media`)).json(); return { file: f, data: data && Array.isArray(data.maps) ? data : { version: 1, maps: [] } }; }
    catch (e) { return { file: f, data: { version: 1, maps: [] } }; }
  }
  function entryFor(m) {
    return {
      driveId: m.driveId || '', page: m.page || 1, address: m.address || '', fileName: m.fileName || '', name: m.name || '',
      w: m.w, h: m.h, pts: (m.pts || []).map((p) => ({ fx: p.x / m.w, fy: p.y / m.h, lat: p.lat, lon: p.lon, src: p.src || 'map' })),
      by: 'app', updated: new Date().toISOString(),
    };
  }
  function findEntry(entries, m) {
    const page = m.page || 1;
    return entries.find((e) => e.driveId && e.driveId === m.driveId && (e.page || 1) === page) ||
      (m.address && entries.find((e) => e.address && norm(e.address) === norm(m.address) && (e.page || 1) === page)) ||
      (m.fileName && entries.find((e) => e.fileName && norm(e.fileName) === norm(m.fileName) && (e.page || 1) === page)) || null;
  }
  // Apply a stored calibration to a map. Points are stored as fractions of the image, so a re-rendered
  // copy of the same PDF fits too. Returns true when the map got a calibration.
  function apply(m, e, from) {
    if (!e || !e.pts || e.pts.length < 2) return false;
    const pts = e.pts.map((p) => ({ x: (p.fx != null ? p.fx : p.x / e.w) * m.w, y: (p.fy != null ? p.fy : p.y / e.h) * m.h, lat: p.lat, lon: p.lon, src: p.src || 'map' }));
    const c = fitCalib(pts); if (!c) return false;
    m.pts = pts; m.calib = c; m.calibFrom = from; m.calibDirty = false;
    return true;
  }

  async function writeAppFile(folderId, maps) {
    const { file, data } = await readJson(folderId, APP_FILE);
    for (const m of maps) {
      const e = entryFor(m);
      const i = data.maps.findIndex((x) => (x.driveId && x.driveId === e.driveId && (x.page || 1) === e.page) || (!x.driveId && x.address && norm(x.address) === norm(e.address)));
      if (i >= 0) data.maps[i] = e; else data.maps.push(e);
    }
    data.version = 1; data.updated = new Date().toISOString();
    const body = JSON.stringify(data, null, 1);
    if (file) {
      try { await api(`https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media&supportsAllDrives=true`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }); return; }
      catch (err) { if (!/ 403/.test(err.message)) throw err; } // made by someone else: fall through and create our own
    }
    const meta = { name: APP_FILE, parents: [folderId], mimeType: 'application/json' };
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
    fd.append('file', new Blob([body], { type: 'application/json' }));
    await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true', { method: 'POST', body: fd });
  }
  // Upload calibrations saved on this phone that Drive doesn't have yet.
  async function pushDirty() {
    const dirty = (await DB.all()).filter((m) => m.calibDirty && m.driveFolder && m.calib);
    const byFolder = new Map();
    dirty.forEach((m) => { if (!byFolder.has(m.driveFolder)) byFolder.set(m.driveFolder, []); byFolder.get(m.driveFolder).push(m); });
    for (const [fid, ms] of byFolder) {
      await writeAppFile(fid, ms);
      for (const m of ms) { m.calibDirty = false; await DB.put(m); }
    }
    return dirty.length;
  }
  let pushT = null;
  function pushSoon(m) {
    if (!m || !m.driveFolder || !haveToken()) return; // otherwise it goes up on the next sync
    clearTimeout(pushT);
    pushT = setTimeout(() => pushDirty().then((n) => n && toast('Calibration saved to Drive too')).catch((e) => console.warn(e)), 500);
  }

  /* ---- sync a folder ---- */
  async function syncFolder(folder) {
    busy(true, 'Looking in ' + folder.name + '…');
    try {
      const files = (await list(`${q(folder.id)} in parents and mimeType = 'application/pdf' and trashed = false`))
        .sort((a, b) => a.name.localeCompare(b.name, 'da', { numeric: true }));
      let maps = await DB.all();
      const have = new Set(maps.filter((m) => m.driveId).map((m) => m.driveId));
      const todo = files.filter((f) => !have.has(f.id));
      // Route name: keep whatever the route from this folder is called on the phone (it may have been renamed).
      const existing = maps.find((m) => m.driveFolder === folder.id);
      const route = existing ? existing.route : folder.name;
      let order = maps.filter((m) => m.route === route).reduce((mx, m) => Math.max(mx, (m.order || 0) + 1), 0);
      let added = 0, failed = 0;
      for (let i = 0; i < todo.length; i++) {
        const f = todo[i];
        busy(true, `Downloading ${i + 1} of ${todo.length} from ${folder.name}…`);
        try {
          const blob = await (await api(`/files/${f.id}?alt=media&supportsAllDrives=true`)).blob();
          const ids = await importFile(new File([blob], f.name, { type: 'application/pdf' }), route, order, { driveId: f.id, driveFolder: folder.id });
          order += ids.length; added += ids.length;
        } catch (e) { console.error(e); failed++; }
      }
      busy(true, 'Checking calibrations…');
      const pushed = await pushDirty().catch((e) => { console.warn(e); return 0; });
      const mine = (await readJson(folder.id, APP_FILE)).data.maps;
      const claude = (await readJson(folder.id, CLAUDE_FILE)).data.maps;
      maps = await DB.all();
      let applied = 0, guessed = 0;
      for (const m of maps) {
        if (m.calib && m.calibFrom !== 'drive' && m.calibFrom !== 'claude') continue; // calibrated on this phone: keep
        const e = findEntry(mine, m);
        if (e && (!m.calib || m.calibFrom !== 'drive' || e.updated !== m.calibUpdated)) {
          if (apply(m, e, 'drive')) { m.calibUpdated = e.updated; await DB.put(m); applied++; }
          continue;
        }
        if (!m.calib) { const g = findEntry(claude, m); if (apply(m, g, 'claude')) { m.calibUpdated = g.updated || ''; await DB.put(m); guessed++; } }
      }
      saveRecent(folder);
      const parts = [];
      parts.push(added ? `${added} new map${added > 1 ? 's' : ''}` : 'No new maps');
      if (applied) parts.push(`${applied} calibration${applied > 1 ? 's' : ''} from Drive`);
      if (guessed) parts.push(`${guessed} first guess${guessed > 1 ? 'es' : ''} to check`);
      if (pushed) parts.push(`${pushed} uploaded`);
      if (failed) parts.push(`${failed} failed`);
      toast(parts.join(' · '), 4500);
    } finally { busy(false); }
    await renderLibrary();
  }

  /* ---- folder picker ---- */
  function recent() { try { return JSON.parse(localStorage.getItem('vk-drive-folders') || '[]'); } catch (e) { return []; } }
  function saveRecent(f) {
    const r = [f, ...recent().filter((x) => x.id !== f.id)].slice(0, 6);
    try { localStorage.setItem('vk-drive-folders', JSON.stringify(r)); } catch (e) {}
  }
  function folderButton(f, sub) {
    const b = document.createElement('button'); b.className = 'card';
    b.innerHTML = `<span class="stopno" aria-hidden="true">▤</span><div class="t"><div class="n">${esc(f.name)}</div><div class="s">${esc(sub || '')}</div></div>`;
    b.onclick = () => { closeSheet(); syncFolder({ id: f.id, name: f.name }).catch((e) => { busy(false); toast(e.message || String(e), 5000); }); };
    return b;
  }
  async function openPicker() {
    const listEl = $('driveList'); listEl.innerHTML = '';
    const rec = recent();
    $('driveRecentWrap').hidden = !rec.length;
    const rl = $('driveRecent'); rl.innerHTML = '';
    rec.forEach((f) => rl.appendChild(folderButton(f, 'Sync again')));
    $('driveMsg').textContent = 'Signing in to Google…';
    openSheet('driveSheet');
    try {
      await getToken();
      $('driveMsg').textContent = 'Loading your folders…';
      const folders = await list("mimeType = 'application/vnd.google-apps.folder' and trashed = false", 'files(id,name,modifiedTime)', 'modifiedTime desc');
      $('driveMsg').textContent = folders.length ? 'Pick the folder for this route. Newest first.' : 'No folders found in your Drive.';
      folders.slice(0, 40).forEach((f) => listEl.appendChild(folderButton(f, 'Changed ' + new Date(f.modifiedTime).toLocaleDateString('da-DK'))));
    } catch (e) { $('driveMsg').textContent = e.message || String(e); }
  }
  $('btnDrive').onclick = openPicker;

  return { getToken, syncFolder, pushSoon, pushDirty, apply, findEntry, entryFor, norm };
})();
window.vkDrive = vkDrive;
