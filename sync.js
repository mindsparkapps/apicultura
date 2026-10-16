// ===== ApiTrack - Cuenta de Google + sincronización con Google Drive =====
// Los datos se guardan en la carpeta oculta de la app en tu Drive (appDataFolder):
//   - apitrack-data.json  -> apiarios, cosechas, ventas, clientes y la galería (sin las fotos)
//   - foto-<hash>         -> cada foto, una sola vez aunque se use en varios registros

const SYNC = {
  token: null,
  tokenExp: 0,
  tokenClient: null,
  fileId: null,
  photoFiles: null,
  busy: false,
  again: false,
  gen: 0,
  timer: null,
  status: 'off'
};

const SYNC_KEYS = {
  ENABLED: 'apitrack_sync_enabled',
  USER: 'apitrack_sync_user',
  DIRTY: 'apitrack_sync_dirty',
  LAST: 'apitrack_sync_last',
  DELETED: 'apitrack_deleted',
  CLIENT_ID: 'apitrack_google_client_id'
};
const DRIVE_SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email profile';
const DATA_FILE_NAME = 'apitrack-data.json';
const PHOTO_PREFIX = 'foto-';
const PHOTO_REF = 'drive-foto:';
const PHOTO_FIELDS = { apiarios: ['foto'], cosechas: ['foto'], fotos: ['data'] };

function googleClientId() {
  return ((window.APITRACK_CONFIG && window.APITRACK_CONFIG.googleClientId) || localStorage.getItem(SYNC_KEYS.CLIENT_ID) || '').trim();
}
function syncEnabled() { return localStorage.getItem(SYNC_KEYS.ENABLED) === '1'; }
function savedUser() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEYS.USER) || 'null'); } catch (e) { return null; }
}
function isDirty() { return localStorage.getItem(SYNC_KEYS.DIRTY) === '1'; }
function setDirty(v) { localStorage.setItem(SYNC_KEYS.DIRTY, v ? '1' : '0'); }
function lastSyncedAt() { return Number(localStorage.getItem(SYNC_KEYS.LAST) || 0); }

function deletions() {
  try { return JSON.parse(localStorage.getItem(SYNC_KEYS.DELETED) || '{}'); } catch (e) { return {}; }
}
function saveDeletions(map) {
  // Se guardan como máximo las 2000 eliminaciones más recientes
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 2000);
  localStorage.setItem(SYNC_KEYS.DELETED, JSON.stringify(Object.fromEntries(entries)));
}
function recordDeletion(store, id) {
  const map = deletions();
  map[`${store}:${id}`] = Date.now();
  saveDeletions(map);
}

// Lo llama app.js cada vez que se agrega, edita o elimina un registro
function onLocalDataChanged() {
  SYNC.gen++;
  setDirty(true);
  if (!syncEnabled()) return;
  if (SYNC.token) scheduleSync(2500);
  else setSyncStatus('pending');
}

function scheduleSync(delay = 2500) {
  clearTimeout(SYNC.timer);
  SYNC.timer = setTimeout(syncNow, delay);
}

// ----- Interfaz -----
const SYNC_STATUS_TEXT = {
  off: 'Sin sincronizar',
  syncing: 'Sincronizando…',
  ok: 'Todo sincronizado con Drive',
  pending: 'Hay cambios sin subir. Toca tu foto para reconectar.',
  expired: 'La sesión de Google expiró. Toca tu foto para reconectar.',
  offline: 'Sin conexión. Se sincronizará al volver.',
  error: 'No se pudo sincronizar. Se reintentará.'
};

function el(id) { return document.getElementById(id); }

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function setSyncStatus(status) {
  SYNC.status = status;
  const dot = el('syncDot');
  if (!dot) return;
  dot.dataset.status = status;
  let text = SYNC_STATUS_TEXT[status] || '';
  if (status === 'ok' && lastSyncedAt()) {
    text += ` · ${new Date(lastSyncedAt()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  el('syncStatusText').textContent = text;
  el('accountChip').title = SYNC_STATUS_TEXT[status] || 'Cuenta';
}

function renderAccount() {
  const user = savedUser();
  const enabled = syncEnabled() && user;
  el('googleSignInBtn').hidden = !!enabled;
  el('accountChip').hidden = !enabled;
  if (!enabled) {
    el('accountMenu').hidden = true;
    return;
  }
  el('accountName').textContent = user.name || 'Cuenta de Google';
  el('accountEmail').textContent = user.email || '';
  el('accountAvatar').innerHTML = user.picture
    ? `<img src="${escapeAttr(user.picture)}" alt="" referrerpolicy="no-referrer">`
    : escapeAttr((user.name || user.email || '?').charAt(0).toUpperCase());
  if (!SYNC.token) setSyncStatus(isDirty() ? 'pending' : 'expired');
}

// ----- Inicio de sesión (Google Identity Services) -----
function initTokenClient() {
  if (SYNC.tokenClient) return true;
  if (!(window.google && google.accounts && google.accounts.oauth2)) return false;
  SYNC.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: googleClientId(),
    scope: DRIVE_SCOPES,
    callback: onTokenResponse,
    error_callback: (err) => {
      console.warn('Google sign-in', err);
      if (err && err.type === 'popup_closed') return;
      showToast('No se pudo abrir el inicio de sesión de Google. Revisa que no estén bloqueadas las ventanas emergentes.', 'error');
    }
  });
  return true;
}

function signInWithGoogle() {
  if (!googleClientId()) {
    showToast('Falta configurar el ID de cliente de Google (config.js)', 'error');
    return;
  }
  if (!initTokenClient()) {
    showToast('Cargando Google… inténtalo de nuevo en un momento', 'info');
    return;
  }
  const user = savedUser();
  SYNC.tokenClient.requestAccessToken({ prompt: user ? '' : 'select_account', login_hint: user ? user.email : undefined });
}

async function onTokenResponse(resp) {
  if (!resp || resp.error) {
    showToast('No se completó el inicio de sesión con Google', 'error');
    return;
  }
  SYNC.token = resp.access_token;
  SYNC.tokenExp = Date.now() + (Number(resp.expires_in || 3600) - 60) * 1000;
  try {
    const info = await (await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${SYNC.token}` }
    })).json();
    const previous = savedUser();
    if (previous && previous.email !== info.email) localStorage.setItem(SYNC_KEYS.LAST, '0');
    localStorage.setItem(SYNC_KEYS.USER, JSON.stringify({ email: info.email, name: info.name, picture: info.picture }));
  } catch (e) {
    console.warn('userinfo', e);
  }
  localStorage.setItem(SYNC_KEYS.ENABLED, '1');
  renderAccount();
  showToast('Sesión iniciada. Sincronizando con Google Drive…', 'info');
  syncNow();
}

function signOutGoogle() {
  if (SYNC.token && window.google && google.accounts && google.accounts.oauth2) {
    try { google.accounts.oauth2.revoke(SYNC.token, () => {}); } catch (e) {}
  }
  SYNC.token = null;
  SYNC.fileId = null;
  SYNC.photoFiles = null;
  localStorage.setItem(SYNC_KEYS.ENABLED, '0');
  localStorage.removeItem(SYNC_KEYS.USER);
  localStorage.setItem(SYNC_KEYS.LAST, '0');
  setSyncStatus('off');
  renderAccount();
  showToast('Sesión cerrada. Tus datos siguen en este dispositivo.', 'info');
}

// ----- Google Drive -----
async function driveFetch(url, opts = {}) {
  if (!SYNC.token || Date.now() > SYNC.tokenExp) {
    SYNC.token = null;
    throw new Error('auth');
  }
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${SYNC.token}` } });
  if (r.status === 401 || r.status === 403) {
    SYNC.token = null;
    throw new Error('auth');
  }
  if (!r.ok) throw new Error(`drive ${r.status}`);
  return r;
}

async function findDataFile() {
  const q = encodeURIComponent(`name='${DATA_FILE_NAME}'`);
  const r = await driveFetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
  const j = await r.json();
  return (j.files && j.files[0]) || null;
}

async function driveUpload(name, blob, existingId = null) {
  if (existingId) {
    await driveFetch(`https://www.googleapis.com/upload/drive/v3/files/${existingId}?uploadType=media`, { method: 'PATCH', body: blob });
    return existingId;
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name, parents: ['appDataFolder'] })], { type: 'application/json' }));
  form.append('file', blob);
  const r = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', body: form });
  return (await r.json()).id;
}

async function listDrivePhotos() {
  const map = new Map();
  let pageToken = '';
  do {
    const q = encodeURIComponent(`name contains '${PHOTO_PREFIX}'`);
    const r = await driveFetch(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&pageSize=1000&fields=nextPageToken,files(id,name)${pageToken ? `&pageToken=${pageToken}` : ''}`);
    const j = await r.json();
    (j.files || []).forEach(f => map.set(f.name.slice(PHOTO_PREFIX.length), f.id));
    pageToken = j.nextPageToken || '';
  } while (pageToken);
  return map;
}

// ----- Fotos: se separan del JSON y se identifican por su contenido -----
const hashCache = new Map();
function photoHash(str) {
  if (hashCache.has(str)) return hashCache.get(str);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hash = (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0') + str.length.toString(16);
  hashCache.set(str, hash);
  return hash;
}

function isPhotoData(v) { return typeof v === 'string' && v.startsWith('data:'); }

// Lee todo IndexedDB y devuelve { payload sin fotos, fotos locales por hash }
async function readLocal() {
  const stores = {};
  const photos = new Map();
  for (const store of STORES) {
    const items = await dbGetAll(store);
    stores[store] = items.map(item => {
      const copy = { ...item };
      (PHOTO_FIELDS[store] || []).forEach(f => {
        if (isPhotoData(copy[f])) {
          const h = photoHash(copy[f]);
          photos.set(h, copy[f]);
          copy[f] = PHOTO_REF + h;
        }
      });
      return copy;
    });
  }
  return { payload: { version: 1, stores, deleted: deletions() }, photos };
}

function mergePayloads(local, remote) {
  const deleted = { ...(remote.deleted || {}) };
  Object.entries(local.deleted || {}).forEach(([k, t]) => { if (!deleted[k] || deleted[k] < t) deleted[k] = t; });
  const stores = {};
  for (const store of STORES) {
    const byId = new Map();
    ((remote.stores || {})[store] || []).forEach(r => byId.set(r.id, r));
    ((local.stores || {})[store] || []).forEach(r => {
      const other = byId.get(r.id);
      if (!other || (r.updatedAt || 0) >= (other.updatedAt || 0)) byId.set(r.id, r);
    });
    stores[store] = [...byId.values()].filter(r => {
      const t = deleted[`${store}:${r.id}`];
      return !t || (r.updatedAt || 0) > t;
    }).sort((a, b) => a.id - b.id);
  }
  return { version: 1, stores, deleted };
}

function sameStores(a, b) {
  return JSON.stringify(a.stores) === JSON.stringify(b.stores);
}

// Reemplaza el contenido de IndexedDB por el de Drive (con las fotos ya descargadas)
async function applyPayload(payload, photos) {
  for (const store of STORES) {
    const items = ((payload.stores || {})[store] || []).map(item => {
      const copy = { ...item };
      (PHOTO_FIELDS[store] || []).forEach(f => {
        if (typeof copy[f] === 'string' && copy[f].startsWith(PHOTO_REF)) {
          copy[f] = photos.get(copy[f].slice(PHOTO_REF.length)) || '';
        }
      });
      return copy;
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      os.clear();
      items.forEach(item => os.put(item));
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  }
  saveDeletions(payload.deleted || {});
  localStorage.setItem('apitrack_seeded', '1');
  updateDashboard();
  refreshPage(currentPage);
}

function referencedPhotos(payload) {
  const set = new Set();
  for (const store of STORES) {
    ((payload.stores || {})[store] || []).forEach(item => {
      (PHOTO_FIELDS[store] || []).forEach(f => {
        if (typeof item[f] === 'string' && item[f].startsWith(PHOTO_REF)) set.add(item[f].slice(PHOTO_REF.length));
      });
    });
  }
  return set;
}

function countRecords(payload) {
  return STORES.reduce((n, s) => n + ((payload.stores || {})[s] || []).length, 0);
}

// ----- Ciclo de sincronización -----
async function syncNow() {
  if (!syncEnabled() || !db) return;
  if (!SYNC.token || Date.now() > SYNC.tokenExp) {
    SYNC.token = null;
    setSyncStatus(isDirty() ? 'pending' : 'expired');
    return;
  }
  if (!navigator.onLine) { setSyncStatus('offline'); return; }
  if (SYNC.busy) { SYNC.again = true; return; }
  SYNC.busy = true;
  setSyncStatus('syncing');
  try {
    const gen = SYNC.gen;
    const file = await findDataFile();
    SYNC.fileId = file ? file.id : null;
    const remote = file ? await (await driveFetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`)).json() : null;
    const { payload: local, photos } = await readLocal();

    let result = local;
    if (remote) {
      if (lastSyncedAt() === 0 && countRecords(local) > 0 && countRecords(remote) > 0) {
        // Primera vez en este dispositivo y ya hay datos en Drive: nunca se pisa nada sin preguntar
        const useDrive = confirm('Ya tienes datos de ApiTrack en tu Google Drive.\n\nAceptar: usar los datos de Drive en este dispositivo (lo que hay aquí se reemplaza).\nCancelar: combinar Drive con lo que hay en este dispositivo (no se pierde nada).');
        result = useDrive ? remote : mergePayloads(local, remote);
      } else {
        result = mergePayloads(local, remote);
      }
    }

    // Descargar las fotos que faltan en este dispositivo
    if (!SYNC.photoFiles) SYNC.photoFiles = await listDrivePhotos();
    for (const h of referencedPhotos(result)) {
      if (!photos.has(h) && SYNC.photoFiles.has(h)) {
        const r = await driveFetch(`https://www.googleapis.com/drive/v3/files/${SYNC.photoFiles.get(h)}?alt=media`);
        photos.set(h, await r.text());
      }
    }

    // Si hubo cambios locales mientras se descargaba, se vuelve a empezar para no perderlos
    if (SYNC.gen !== gen) { SYNC.again = true; return; }

    if (!sameStores(result, local)) await applyPayload(result, photos);
    else saveDeletions(result.deleted || {});

    // Subir las fotos nuevas
    for (const h of referencedPhotos(result)) {
      if (photos.has(h) && !SYNC.photoFiles.has(h)) {
        SYNC.photoFiles.set(h, await driveUpload(PHOTO_PREFIX + h, new Blob([photos.get(h)], { type: 'text/plain' })));
      }
    }

    if (!remote || !sameStores(result, remote) || JSON.stringify(result.deleted || {}) !== JSON.stringify(remote.deleted || {})) {
      const data = { ...result, savedAt: Date.now() };
      SYNC.fileId = await driveUpload(DATA_FILE_NAME, new Blob([JSON.stringify(data)], { type: 'application/json' }), SYNC.fileId);
    }
    localStorage.setItem(SYNC_KEYS.LAST, String(Date.now()));
    if (SYNC.gen === gen) setDirty(false);
    setSyncStatus(isDirty() ? 'syncing' : 'ok');
  } catch (err) {
    console.warn('Sincronización', err);
    if (err.message === 'auth') setSyncStatus(isDirty() ? 'pending' : 'expired');
    else setSyncStatus(navigator.onLine ? 'error' : 'offline');
  } finally {
    SYNC.busy = false;
    if (SYNC.again || (isDirty() && SYNC.token)) {
      SYNC.again = false;
      scheduleSync(2000);
    }
  }
}

// Los registros antiguos usaban ids 1, 2, 3… que chocarían entre dispositivos:
// se les asigna un id único una sola vez, actualizando las referencias entre ellos
async function migrateLegacyIds() {
  if (localStorage.getItem('apitrack_ids_migrated') === '1') return;
  const all = {};
  for (const store of STORES) all[store] = await dbGetAll(store);
  const maps = {};
  let changed = false;
  for (const store of STORES) {
    maps[store] = new Map();
    all[store].forEach(r => {
      if (typeof r.id === 'number' && r.id < 1e12) { maps[store].set(r.id, newRecordId()); changed = true; }
    });
  }
  if (changed) {
    const now = Date.now();
    for (const store of STORES) {
      const items = all[store].map(r => {
        const c = { ...r, id: maps[store].get(r.id) || r.id, updatedAt: now };
        if (c.apiarioId != null && maps.apiarios.has(c.apiarioId)) c.apiarioId = maps.apiarios.get(c.apiarioId);
        if (c.clienteId != null && maps.clientes.has(c.clienteId)) c.clienteId = maps.clientes.get(c.clienteId);
        return c;
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(store, 'readwrite');
        const os = tx.objectStore(store);
        os.clear();
        items.forEach(i => os.put(i));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    }
    setDirty(true);
    updateDashboard();
    refreshPage(currentPage);
  }
  localStorage.setItem('apitrack_ids_migrated', '1');
}

// ----- Arranque -----
async function startSync() {
  try { await migrateLegacyIds(); } catch (e) { console.warn('Migración de ids', e); }
  el('googleSignInBtn').addEventListener('click', signInWithGoogle);
  el('accountChip').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!SYNC.token || Date.now() > SYNC.tokenExp) { signInWithGoogle(); return; }
    el('accountMenu').hidden = !el('accountMenu').hidden;
  });
  document.addEventListener('click', (e) => {
    if (!el('accountMenu').hidden && !e.target.closest('#accountArea')) el('accountMenu').hidden = true;
  });
  el('syncNowBtn').addEventListener('click', () => { el('accountMenu').hidden = true; syncNow(); });
  el('signOutBtn').addEventListener('click', () => { el('accountMenu').hidden = true; signOutGoogle(); });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && SYNC.token) syncNow();
  });
  window.addEventListener('online', () => { if (SYNC.token) syncNow(); });
  setInterval(() => { if (SYNC.token && document.visibilityState === 'visible') syncNow(); }, 45000);

  renderAccount();
}
