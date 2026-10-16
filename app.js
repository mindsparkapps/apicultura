// ===== ApiTrack - Aplicación de Gestión Apícola =====
// Almacenamiento local con IndexedDB

const DB_NAME = 'ApiTrackDB';
const DB_VERSION = 1;
const STORES = ['apiarios', 'cosechas', 'ventas', 'clientes', 'fotos'];

let db = null;
let currentPage = 'dashboard';
let cameraStream = null;
let cameraTargetField = null;
let cameraFacingMode = 'environment'; // back camera by default
let pendingDelete = { type: null, id: null };

// ===== DATABASE =====
function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const database = e.target.result;
      STORES.forEach(store => {
        if (!database.objectStoreNames.contains(store)) {
          database.createObjectStore(store, { keyPath: 'id', autoIncrement: true });
        }
      });
    };
    request.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };
    request.onerror = (e) => reject(e.target.error);
  });
}

// Ids únicos entre dispositivos (numéricos para que parseInt siga funcionando)
let lastGeneratedId = 0;
function newRecordId() {
  let id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
  if (id <= lastGeneratedId) id = lastGeneratedId + 1;
  lastGeneratedId = id;
  return id;
}

function dbAdd(store, data) {
  return new Promise((resolve, reject) => {
    if (data.id == null) data.id = newRecordId();
    data.updatedAt = Date.now();
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).add(data);
    req.onsuccess = () => { resolve(req.result); notifyDataChanged(); };
    req.onerror = () => reject(req.error);
  });
}

function dbPut(store, data) {
  return new Promise((resolve, reject) => {
    data.updatedAt = Date.now();
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).put(data);
    req.onsuccess = () => { resolve(req.result); notifyDataChanged(); };
    req.onerror = () => reject(req.error);
  });
}

function dbDelete(store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    const req = tx.objectStore(store).delete(id);
    req.onsuccess = () => {
      if (typeof recordDeletion === 'function') recordDeletion(store, id);
      resolve();
      notifyDataChanged();
    };
    req.onerror = () => reject(req.error);
  });
}

function notifyDataChanged() {
  if (typeof onLocalDataChanged === 'function') onLocalDataChanged();
}

function dbGetAll(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function dbGet(store, id) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ===== NAVIGATION =====
function navigateTo(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const pageEl = document.getElementById(`page-${page}`);
  const navEl = document.querySelector(`.nav-item[data-page="${page}"]`);
  if (pageEl) pageEl.classList.add('active');
  if (navEl) navEl.classList.add('active');

  const titles = {
    dashboard: 'Dashboard',
    apiarios: 'Apiarios',
    cosechas: 'Cosechas',
    ventas: 'Ventas',
    clientes: 'Clientes',
    galeria: 'Galería'
  };
  document.getElementById('pageTitle').textContent = titles[page] || page;

  // Synchronize mobile bottom nav
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-page') === page);
  });

  closeSidebar();
  refreshPage(page);
}

function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('active');
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('active');
}

// ===== MODAL =====
function openModal(id) {
  document.getElementById(id).classList.add('active');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('active');
  // Stop camera if camera modal closes
  if (id === 'cameraModal') {
    stopCamera();
  }
}

// ===== TOAST =====
function showToast(message, type = 'success') {
  const container = document.getElementById('toastContainer');
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || '✅'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 3100);
}

// ===== FAB =====
function onFabClick() {
  const modals = {
    apiarios: 'apiarioModal',
    cosechas: 'cosechaModal',
    ventas: 'ventaModal',
    clientes: 'clienteModal',
    galeria: null,
    dashboard: null
  };
  if (currentPage === 'galeria') {
    openCamera();
  } else if (modals[currentPage]) {
    resetForm(currentPage);
    openModal(modals[currentPage]);
  } else {
    openCamera();
  }
}

// ===== CAMERA =====
function triggerNativeCameraFallback(targetField) {
  if (targetField !== undefined && targetField !== null) {
    cameraTargetField = targetField;
  }
  const camInput = document.getElementById('cameraFileInput');
  if (camInput) {
    camInput.click();
  } else {
    document.getElementById('fileInput').click();
  }
}

async function openCamera(targetField) {
  cameraTargetField = targetField || null;
  // If not supported or insecure origin without getUserMedia
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Abriendo cámara del dispositivo...', 'info');
    triggerNativeCameraFallback(targetField);
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    const video = document.getElementById('cameraVideo');
    video.srcObject = cameraStream;
    openModal('cameraModal');
  } catch (err) {
    console.warn('Camera getUserMedia error, falling back to native camera:', err);
    showToast('Abriendo cámara del dispositivo...', 'info');
    triggerNativeCameraFallback(targetField);
  }
}

function stopCamera() {
  if (cameraStream) {
    cameraStream.getTracks().forEach(t => t.stop());
    cameraStream = null;
  }
  const video = document.getElementById('cameraVideo');
  video.srcObject = null;
}

function closeCameraModal() {
  stopCamera();
  closeModal('cameraModal');
}

async function switchCameraFacing() {
  cameraFacingMode = cameraFacingMode === 'environment' ? 'user' : 'environment';
  stopCamera();
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: cameraFacingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    document.getElementById('cameraVideo').srcObject = cameraStream;
  } catch (err) {
    showToast('No se pudo cambiar la cámara', 'error');
  }
}

function takeSnapshot() {
  const video = document.getElementById('cameraVideo');
  const canvas = document.getElementById('cameraCanvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.8);

  if (cameraTargetField) {
    setPhotoField(cameraTargetField, dataUrl);
  } else {
    savePhotoToGallery(dataUrl);
  }

  closeCameraModal();
  showToast('Foto capturada correctamente');
}

// ===== PHOTO FIELDS =====
function captureForField(fieldId) {
  openCamera(fieldId);
}

function uploadForField(fieldId) {
  cameraTargetField = fieldId;
  document.getElementById('fileInput').click();
}

function uploadPhoto() {
  cameraTargetField = null;
  document.getElementById('fileInput').click();
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    if (cameraTargetField) {
      setPhotoField(cameraTargetField, dataUrl);
    } else {
      savePhotoToGallery(dataUrl);
    }
    showToast('Imagen cargada correctamente');
  };
  reader.readAsDataURL(file);
  event.target.value = '';
}

function setPhotoField(fieldId, dataUrl) {
  document.getElementById(fieldId).value = dataUrl;
  const previewId = fieldId + 'Preview';
  const preview = document.getElementById(previewId);
  if (preview) {
    preview.innerHTML = `<img src="${dataUrl}" alt="Foto">`;
  }
  const clearBtn = document.getElementById(fieldId + 'Clear');
  if (clearBtn) clearBtn.style.display = 'inline-flex';
}

function clearPhotoField(fieldId) {
  document.getElementById(fieldId).value = '';
  const previewId = fieldId + 'Preview';
  const preview = document.getElementById(previewId);
  if (preview) {
    preview.innerHTML = `<span class="icon">📷</span><span>Tomar foto o seleccionar imagen</span>`;
  }
  const clearBtn = document.getElementById(fieldId + 'Clear');
  if (clearBtn) clearBtn.style.display = 'none';
}

async function savePhotoToGallery(dataUrl) {
  const photo = {
    data: dataUrl,
    fecha: new Date().toISOString(),
    tipo: 'general'
  };
  await dbAdd('fotos', photo);
  if (currentPage === 'galeria') renderGallery();
  updateDashboard();
}

// ===== PHOTO VIEWER =====
function viewPhoto(src) {
  document.getElementById('photoViewerImg').src = src;
  document.getElementById('photoViewer').classList.add('active');
}

function closePhotoViewer() {
  document.getElementById('photoViewer').classList.remove('active');
}

// ===== DELETE =====
function requestDelete(type, id) {
  pendingDelete = { type, id };
  openModal('deleteModal');
}

async function confirmDelete() {
  if (pendingDelete.type && pendingDelete.id) {
    await dbDelete(pendingDelete.type, pendingDelete.id);
    showToast('Registro eliminado');
    closeModal('deleteModal');
    refreshPage(currentPage);
    updateDashboard();
  }
}

// ===== FORM RESET =====
function resetForm(page) {
  if (page === 'apiarios') {
    document.getElementById('apiarioId').value = '';
    document.getElementById('apiarioNombre').value = '';
    document.getElementById('apiarioUbicacion').value = '';
    document.getElementById('apiarioColmenas').value = '';
    document.getElementById('apiarioEstado').value = 'activo';
    document.getElementById('apiarioNotas').value = '';
    clearPhotoField('apiarioPhoto');
    document.getElementById('apiarioModalTitle').textContent = 'Nuevo Apiario';
  } else if (page === 'cosechas') {
    document.getElementById('cosechaId').value = '';
    document.getElementById('cosechaFecha').value = new Date().toISOString().split('T')[0];
    document.getElementById('cosechaApiario').value = '';
    document.getElementById('cosechaProducto').value = 'miel';
    document.getElementById('cosechaCantidad').value = '';
    document.getElementById('cosechaCalidad').value = 'estandar';
    document.getElementById('cosechaNotas').value = '';
    clearPhotoField('cosechaPhoto');
    document.getElementById('cosechaModalTitle').textContent = 'Nueva Cosecha';
    populateApiarioSelect();
  } else if (page === 'ventas') {
    document.getElementById('ventaId').value = '';
    document.getElementById('ventaFecha').value = new Date().toISOString().split('T')[0];
    document.getElementById('ventaCliente').value = '';
    document.getElementById('ventaProducto').value = 'miel';
    document.getElementById('ventaCantidad').value = '';
    document.getElementById('ventaPrecio').value = '';
    document.getElementById('ventaTotalCalc').value = '';
    document.getElementById('ventaEstado').value = 'pendiente';
    document.getElementById('ventaNotas').value = '';
    document.getElementById('ventaModalTitle').textContent = 'Nueva Venta';
    populateClienteSelect();
  } else if (page === 'clientes') {
    document.getElementById('clienteId').value = '';
    document.getElementById('clienteNombre').value = '';
    document.getElementById('clienteTelefono').value = '';
    document.getElementById('clienteEmail').value = '';
    document.getElementById('clienteDireccion').value = '';
    document.getElementById('clienteNotas').value = '';
    document.getElementById('clienteModalTitle').textContent = 'Nuevo Cliente';
  }
}

// ===== POPULATE SELECTS =====
async function populateApiarioSelect() {
  const apiarios = await dbGetAll('apiarios');
  const select = document.getElementById('cosechaApiario');
  select.innerHTML = '<option value="">Seleccionar...</option>';
  apiarios.forEach(a => {
    select.innerHTML += `<option value="${a.id}">${a.nombre}</option>`;
  });
}

async function populateClienteSelect() {
  const clientes = await dbGetAll('clientes');
  const select = document.getElementById('ventaCliente');
  select.innerHTML = '<option value="">Seleccionar...</option>';
  clientes.forEach(c => {
    select.innerHTML += `<option value="${c.id}">${c.nombre}</option>`;
  });
}

// ===== SAVE OPERATIONS =====
async function saveApiario() {
  const nombre = document.getElementById('apiarioNombre').value.trim();
  if (!nombre) return showToast('El nombre del apiario es requerido', 'error');

  const data = {
    nombre,
    ubicacion: document.getElementById('apiarioUbicacion').value.trim(),
    colmenas: parseInt(document.getElementById('apiarioColmenas').value) || 0,
    estado: document.getElementById('apiarioEstado').value,
    notas: document.getElementById('apiarioNotas').value.trim(),
    foto: document.getElementById('apiarioPhoto').value || '',
    fecha: new Date().toISOString()
  };

  const idStr = document.getElementById('apiarioId').value;
  if (idStr) {
    data.id = parseInt(idStr);
    await dbPut('apiarios', data);
    showToast('Apiario actualizado correctamente');
  } else {
    await dbAdd('apiarios', data);
    showToast('Apiario registrado correctamente');
  }

  closeModal('apiarioModal');
  refreshPage('apiarios');
  updateDashboard();
}

async function saveCosecha() {
  const fecha = document.getElementById('cosechaFecha').value;
  const apiario = document.getElementById('cosechaApiario').value;
  const cantidad = parseFloat(document.getElementById('cosechaCantidad').value);

  if (!fecha || !apiario || !cantidad) {
    return showToast('Completa los campos requeridos', 'error');
  }

  const apiarioData = await dbGet('apiarios', parseInt(apiario));

  const data = {
    fecha,
    apiarioId: parseInt(apiario),
    apiarioNombre: apiarioData ? apiarioData.nombre : 'Desconocido',
    producto: document.getElementById('cosechaProducto').value,
    cantidad,
    calidad: document.getElementById('cosechaCalidad').value,
    notas: document.getElementById('cosechaNotas').value.trim(),
    foto: document.getElementById('cosechaPhoto').value || '',
    createdAt: new Date().toISOString()
  };

  const idStr = document.getElementById('cosechaId').value;
  if (idStr) {
    data.id = parseInt(idStr);
    await dbPut('cosechas', data);
    showToast('Cosecha actualizada correctamente');
  } else {
    await dbAdd('cosechas', data);
    showToast('Cosecha registrada correctamente');
  }

  closeModal('cosechaModal');
  refreshPage('cosechas');
  updateDashboard();
}

async function saveVenta() {
  const fecha = document.getElementById('ventaFecha').value;
  const clienteId = document.getElementById('ventaCliente').value;
  const cantidad = parseFloat(document.getElementById('ventaCantidad').value);
  const precio = parseFloat(document.getElementById('ventaPrecio').value);

  if (!fecha || !clienteId || !cantidad || !precio) {
    return showToast('Completa los campos requeridos', 'error');
  }

  const clienteData = await dbGet('clientes', parseInt(clienteId));

  const data = {
    fecha,
    clienteId: parseInt(clienteId),
    clienteNombre: clienteData ? clienteData.nombre : 'Desconocido',
    producto: document.getElementById('ventaProducto').value,
    cantidad,
    precio,
    total: cantidad * precio,
    estado: document.getElementById('ventaEstado').value,
    notas: document.getElementById('ventaNotas').value.trim(),
    createdAt: new Date().toISOString()
  };

  const idStr = document.getElementById('ventaId').value;
  if (idStr) {
    data.id = parseInt(idStr);
    await dbPut('ventas', data);
    showToast('Venta actualizada correctamente');
  } else {
    await dbAdd('ventas', data);
    showToast('Venta registrada correctamente');
  }

  closeModal('ventaModal');
  refreshPage('ventas');
  updateDashboard();
}

async function saveCliente() {
  const nombre = document.getElementById('clienteNombre').value.trim();
  if (!nombre) return showToast('El nombre es requerido', 'error');

  const data = {
    nombre,
    telefono: document.getElementById('clienteTelefono').value.trim(),
    email: document.getElementById('clienteEmail').value.trim(),
    direccion: document.getElementById('clienteDireccion').value.trim(),
    notas: document.getElementById('clienteNotas').value.trim(),
    fecha: new Date().toISOString()
  };

  const idStr = document.getElementById('clienteId').value;
  if (idStr) {
    data.id = parseInt(idStr);
    await dbPut('clientes', data);
    showToast('Cliente actualizado correctamente');
  } else {
    await dbAdd('clientes', data);
    showToast('Cliente registrado correctamente');
  }

  closeModal('clienteModal');
  refreshPage('clientes');
}

// ===== EDIT OPERATIONS =====
async function editApiario(id) {
  const data = await dbGet('apiarios', id);
  if (!data) return;
  document.getElementById('apiarioId').value = data.id;
  document.getElementById('apiarioNombre').value = data.nombre;
  document.getElementById('apiarioUbicacion').value = data.ubicacion || '';
  document.getElementById('apiarioColmenas').value = data.colmenas || 0;
  document.getElementById('apiarioEstado').value = data.estado || 'activo';
  document.getElementById('apiarioNotas').value = data.notas || '';
  if (data.foto) {
    setPhotoField('apiarioPhoto', data.foto);
  } else {
    clearPhotoField('apiarioPhoto');
  }
  document.getElementById('apiarioModalTitle').textContent = 'Editar Apiario';
  openModal('apiarioModal');
}

async function editCosecha(id) {
  const data = await dbGet('cosechas', id);
  if (!data) return;
  await populateApiarioSelect();
  document.getElementById('cosechaId').value = data.id;
  document.getElementById('cosechaFecha').value = data.fecha;
  document.getElementById('cosechaApiario').value = data.apiarioId;
  document.getElementById('cosechaProducto').value = data.producto;
  document.getElementById('cosechaCantidad').value = data.cantidad;
  document.getElementById('cosechaCalidad').value = data.calidad;
  document.getElementById('cosechaNotas').value = data.notas || '';
  if (data.foto) {
    setPhotoField('cosechaPhoto', data.foto);
  } else {
    clearPhotoField('cosechaPhoto');
  }
  document.getElementById('cosechaModalTitle').textContent = 'Editar Cosecha';
  openModal('cosechaModal');
}

async function editVenta(id) {
  const data = await dbGet('ventas', id);
  if (!data) return;
  await populateClienteSelect();
  document.getElementById('ventaId').value = data.id;
  document.getElementById('ventaFecha').value = data.fecha;
  document.getElementById('ventaCliente').value = data.clienteId;
  document.getElementById('ventaProducto').value = data.producto;
  document.getElementById('ventaCantidad').value = data.cantidad;
  document.getElementById('ventaPrecio').value = data.precio;
  document.getElementById('ventaTotalCalc').value = `$${data.total.toFixed(2)}`;
  document.getElementById('ventaEstado').value = data.estado;
  document.getElementById('ventaNotas').value = data.notas || '';
  document.getElementById('ventaModalTitle').textContent = 'Editar Venta';
  openModal('ventaModal');
}

async function editCliente(id) {
  const data = await dbGet('clientes', id);
  if (!data) return;
  document.getElementById('clienteId').value = data.id;
  document.getElementById('clienteNombre').value = data.nombre;
  document.getElementById('clienteTelefono').value = data.telefono || '';
  document.getElementById('clienteEmail').value = data.email || '';
  document.getElementById('clienteDireccion').value = data.direccion || '';
  document.getElementById('clienteNotas').value = data.notas || '';
  document.getElementById('clienteModalTitle').textContent = 'Editar Cliente';
  openModal('clienteModal');
}

// ===== CALC =====
function calcVentaTotal() {
  const cant = parseFloat(document.getElementById('ventaCantidad').value) || 0;
  const precio = parseFloat(document.getElementById('ventaPrecio').value) || 0;
  document.getElementById('ventaTotalCalc').value = `$${(cant * precio).toFixed(2)}`;
}

// ===== RENDER TABLES =====
async function renderApiarios() {
  const data = await dbGetAll('apiarios');
  const tbody = document.getElementById('apiarioTable');
  document.getElementById('apiarioCount').textContent = data.length;

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state"><div class="icon">🏡</div><p>No hay apiarios registrados</p></td></tr>`;
    return;
  }

  const estadoBadge = { activo: 'badge-green', inactivo: 'badge-red', mantenimiento: 'badge-gold' };
  const estadoLabel = { activo: '✅ Activo', inactivo: '❌ Inactivo', mantenimiento: '🔧 Mantenimiento' };

  tbody.innerHTML = data.map(a => `
    <tr data-search="${(a.nombre + ' ' + a.ubicacion).toLowerCase()}">
      <td>${a.foto ? `<img class="td-image" src="${a.foto}" onclick="viewPhoto('${a.foto.substring(0, 50)}...')" style="cursor:pointer">` : '<span style="color:var(--text-muted)">📷</span>'}</td>
      <td class="td-bold">${a.nombre}</td>
      <td>${a.ubicacion || '—'}</td>
      <td>${a.colmenas || 0}</td>
      <td><span class="badge ${estadoBadge[a.estado] || 'badge-green'}">${estadoLabel[a.estado] || a.estado}</span></td>
      <td>
        <div class="td-actions">
          <button class="btn btn-secondary btn-icon btn-sm" onclick="editApiario(${a.id})" title="Editar">✏️</button>
          <button class="btn btn-danger btn-icon btn-sm" onclick="requestDelete('apiarios', ${a.id})" title="Eliminar">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');

  // Fix photo viewer for full data URLs
  data.forEach(a => {
    if (a.foto) {
      const img = tbody.querySelector(`tr[data-search*="${a.nombre.toLowerCase()}"] .td-image`);
      if (img) {
        img.onclick = () => viewPhoto(a.foto);
      }
    }
  });
}

async function renderCosechas(filter = 'todas') {
  let data = await dbGetAll('cosechas');
  if (filter !== 'todas') {
    data = data.filter(c => c.producto === filter);
  }

  const tbody = document.getElementById('cosechaTable');
  const productoEmoji = { miel: '🍯', cera: '🕯️', polen: '🌼', propoleo: '💊', jalea: '👑' };
  const calidadBadge = { premium: 'badge-gold', estandar: 'badge-green', segunda: 'badge-blue' };
  const calidadLabel = { premium: '⭐ Premium', estandar: '✅ Estándar', segunda: '📌 Segunda' };

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state"><div class="icon">🍯</div><p>No hay cosechas registradas</p></td></tr>`;
    updateCosechaStats([]);
    return;
  }

  data.sort((a, b) => b.fecha.localeCompare(a.fecha));
  updateCosechaStats(data);

  tbody.innerHTML = data.map(c => `
    <tr data-search="${(c.apiarioNombre + ' ' + c.producto + ' ' + c.fecha).toLowerCase()}" data-id="${c.id}">
      <td>${c.foto ? `<img class="td-image" src="${c.foto}" style="cursor:pointer">` : '<span style="color:var(--text-muted)">📷</span>'}</td>
      <td class="td-bold">${formatDate(c.fecha)}</td>
      <td>${c.apiarioNombre}</td>
      <td>${productoEmoji[c.producto] || ''} ${capitalize(c.producto)}</td>
      <td class="td-bold">${c.cantidad} kg</td>
      <td><span class="badge ${calidadBadge[c.calidad] || 'badge-green'}">${calidadLabel[c.calidad] || c.calidad}</span></td>
      <td>${c.notas ? truncate(c.notas, 30) : '—'}</td>
      <td>
        <div class="td-actions">
          <button class="btn btn-secondary btn-icon btn-sm" onclick="editCosecha(${c.id})" title="Editar">✏️</button>
          <button class="btn btn-danger btn-icon btn-sm" onclick="requestDelete('cosechas', ${c.id})" title="Eliminar">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');

  // Bind photo clicks
  data.forEach(c => {
    if (c.foto) {
      const row = tbody.querySelector(`tr[data-id="${c.id}"] .td-image`);
      if (row) row.onclick = () => viewPhoto(c.foto);
    }
  });
}

async function renderVentas(filter = 'todas') {
  let data = await dbGetAll('ventas');
  if (filter !== 'todas') {
    data = data.filter(v => v.estado === filter);
  }

  const tbody = document.getElementById('ventaTable');
  const productoEmoji = { miel: '🍯', cera: '🕯️', polen: '🌼', propoleo: '💊', jalea: '👑' };
  const estadoBadge = { pendiente: 'badge-gold', pagada: 'badge-green', entregada: 'badge-blue' };
  const estadoLabel = { pendiente: '🟡 Pendiente', pagada: '🟢 Pagada', entregada: '📦 Entregada' };

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty-state"><div class="icon">💰</div><p>No hay ventas registradas</p></td></tr>`;
    updateVentaStats([]);
    return;
  }

  data.sort((a, b) => b.fecha.localeCompare(a.fecha));
  updateVentaStats(data);

  tbody.innerHTML = data.map(v => `
    <tr data-search="${(v.clienteNombre + ' ' + v.producto + ' ' + v.fecha).toLowerCase()}">
      <td class="td-bold">${formatDate(v.fecha)}</td>
      <td>${v.clienteNombre}</td>
      <td>${productoEmoji[v.producto] || ''} ${capitalize(v.producto)}</td>
      <td>${v.cantidad} kg</td>
      <td>$${v.precio.toFixed(2)}</td>
      <td class="td-bold" style="color:var(--accent-gold)">$${v.total.toFixed(2)}</td>
      <td><span class="badge ${estadoBadge[v.estado] || 'badge-green'}">${estadoLabel[v.estado] || v.estado}</span></td>
      <td>
        <div class="td-actions">
          <button class="btn btn-secondary btn-icon btn-sm" onclick="editVenta(${v.id})" title="Editar">✏️</button>
          <button class="btn btn-danger btn-icon btn-sm" onclick="requestDelete('ventas', ${v.id})" title="Eliminar">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');
}

async function renderClientes() {
  const data = await dbGetAll('clientes');
  const ventas = await dbGetAll('ventas');
  const tbody = document.getElementById('clienteTable');

  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state"><div class="icon">👥</div><p>No hay clientes registrados</p></td></tr>`;
    return;
  }

  tbody.innerHTML = data.map(c => {
    const clienteVentas = ventas.filter(v => v.clienteId === c.id);
    const totalCompras = clienteVentas.reduce((sum, v) => sum + v.total, 0);
    return `
      <tr data-search="${(c.nombre + ' ' + (c.telefono || '') + ' ' + (c.email || '')).toLowerCase()}">
        <td class="td-bold">${c.nombre}</td>
        <td>${c.telefono || '—'}</td>
        <td>${c.email || '—'}</td>
        <td>${c.direccion || '—'}</td>
        <td>${clienteVentas.length}</td>
        <td class="td-bold" style="color:var(--accent-gold)">$${totalCompras.toFixed(2)}</td>
        <td>
          <div class="td-actions">
            <button class="btn btn-secondary btn-icon btn-sm" onclick="editCliente(${c.id})" title="Editar">✏️</button>
            <button class="btn btn-danger btn-icon btn-sm" onclick="requestDelete('clientes', ${c.id})" title="Eliminar">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

async function renderGallery() {
  const fotos = await dbGetAll('fotos');
  const grid = document.getElementById('galleryGrid');

  // Also gather photos from apiarios and cosechas
  const apiarios = await dbGetAll('apiarios');
  const cosechas = await dbGetAll('cosechas');

  const allPhotos = [];
  fotos.forEach(f => allPhotos.push({ src: f.data, label: 'Galería', fecha: f.fecha, type: 'fotos', id: f.id }));
  apiarios.forEach(a => { if (a.foto) allPhotos.push({ src: a.foto, label: a.nombre, fecha: a.fecha, type: 'apiario' }); });
  cosechas.forEach(c => { if (c.foto) allPhotos.push({ src: c.foto, label: `${capitalize(c.producto)} - ${c.apiarioNombre}`, fecha: c.createdAt, type: 'cosecha' }); });

  allPhotos.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || ''));

  if (allPhotos.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="icon">📷</div><p>No hay fotos. Toma una con la cámara o sube una imagen.</p></div>`;
    return;
  }

  grid.innerHTML = allPhotos.map((p, i) => `
    <div class="gallery-item" data-idx="${i}">
      <img src="${p.src}" alt="${p.label}" loading="lazy">
      <div class="overlay">${p.label}</div>
    </div>
  `).join('');

  grid.querySelectorAll('.gallery-item').forEach((item, i) => {
    item.onclick = () => viewPhoto(allPhotos[i].src);
  });
}

// ===== STATS =====
function updateCosechaStats(data) {
  const total = data.reduce((s, c) => s + c.cantidad, 0);
  const now = new Date();
  const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const mesDatos = data.filter(c => c.fecha.startsWith(mesActual));
  const mesTotal = mesDatos.reduce((s, c) => s + c.cantidad, 0);
  const prom = data.length > 0 ? (total / data.length) : 0;

  document.getElementById('cosechaTotal').textContent = `${total.toFixed(1)} kg`;
  document.getElementById('cosechaMes').textContent = `${mesTotal.toFixed(1)} kg`;
  document.getElementById('cosechaPromedio').textContent = `${prom.toFixed(1)} kg`;
}

function updateVentaStats(data) {
  const total = data.reduce((s, v) => s + v.total, 0);
  const now = new Date();
  const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const mesDatos = data.filter(v => v.fecha.startsWith(mesActual));
  const mesTotal = mesDatos.reduce((s, v) => s + v.total, 0);

  document.getElementById('ventaTotal').textContent = `$${total.toFixed(2)}`;
  document.getElementById('ventaMes').textContent = `$${mesTotal.toFixed(2)}`;
  document.getElementById('ventaCantidad').textContent = data.length;
}

// ===== DASHBOARD =====
async function updateDashboard() {
  const apiarios = await dbGetAll('apiarios');
  const cosechas = await dbGetAll('cosechas');
  const ventas = await dbGetAll('ventas');
  const fotos = await dbGetAll('fotos');

  document.getElementById('statApiarios').textContent = apiarios.length;
  document.getElementById('apiarioCount').textContent = apiarios.length;

  const totalProd = cosechas.reduce((s, c) => s + c.cantidad, 0);
  document.getElementById('statProduccion').textContent = `${totalProd.toFixed(1)} kg`;

  const now = new Date();
  const mesActual = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const ventasMes = ventas.filter(v => v.fecha.startsWith(mesActual));
  const totalVentasMes = ventasMes.reduce((s, v) => s + v.total, 0);
  document.getElementById('statVentas').textContent = `$${totalVentasMes.toFixed(0)}`;

  // Count all photos
  const fotoCount = fotos.length + apiarios.filter(a => a.foto).length + cosechas.filter(c => c.foto).length;
  document.getElementById('statFotos').textContent = fotoCount;

  // Stock e Inventario
  renderInventoryStock(cosechas, ventas);

  // Charts
  renderProductionChart(cosechas);
  renderSalesChart(ventas);

  // Recent activity
  renderRecentActivity(cosechas, ventas);
}

function renderInventoryStock(cosechas, ventas) {
  const tbody = document.getElementById('inventoryStockTable');
  if (!tbody) return;

  const productos = [
    { id: 'miel', name: 'Miel de Abejas', icon: '🍯', unit: 'kg' },
    { id: 'cera', name: 'Cera de Opérculo', icon: '🕯️', unit: 'kg' },
    { id: 'polen', name: 'Polen Apícola', icon: '🌼', unit: 'kg' },
    { id: 'propoleo', name: 'Propóleo Bruto', icon: '💊', unit: 'kg' },
    { id: 'jalea', name: 'Jalea Real', icon: '👑', unit: 'kg' }
  ];

  tbody.innerHTML = productos.map(p => {
    const totalCosechado = cosechas
      .filter(c => c.producto === p.id)
      .reduce((sum, c) => sum + (Number(c.cantidad) || 0), 0);
    const totalVendido = ventas
      .filter(v => v.producto === p.id)
      .reduce((sum, v) => sum + (Number(v.cantidad) || 0), 0);
    const stockDisponible = Math.max(0, totalCosechado - totalVendido);

    let statusBadge = '<span class="badge badge-red">🔴 Sin Stock</span>';
    if (stockDisponible > 20) {
      statusBadge = '<span class="badge badge-green">🟢 Stock Óptimo</span>';
    } else if (stockDisponible > 0) {
      statusBadge = '<span class="badge badge-gold">🟡 Stock Bajo</span>';
    }

    return `
      <tr>
        <td class="td-bold">${p.icon} ${p.name}</td>
        <td>${totalCosechado.toFixed(1)} ${p.unit}</td>
        <td>${totalVendido.toFixed(1)} ${p.unit}</td>
        <td class="td-bold" style="color:${stockDisponible > 0 ? 'var(--accent-gold)' : 'var(--danger)'}">
          ${stockDisponible.toFixed(1)} ${p.unit}
        </td>
        <td>${statusBadge}</td>
      </tr>
    `;
  }).join('');
}

function renderProductionChart(cosechas) {
  const container = document.getElementById('chartProduccion');
  const months = getLastMonths(6);
  const data = months.map(m => {
    const filtered = cosechas.filter(c => c.fecha.startsWith(m.key));
    return { label: m.label, value: filtered.reduce((s, c) => s + c.cantidad, 0) };
  });

  const max = Math.max(...data.map(d => d.value), 1);
  container.innerHTML = data.map(d => `
    <div class="chart-bar-wrapper">
      <div class="chart-bar-value">${d.value > 0 ? d.value.toFixed(0) : ''}</div>
      <div class="chart-bar gold" style="height:${(d.value / max) * 180}px"></div>
      <div class="chart-bar-label">${d.label}</div>
    </div>
  `).join('');

  // Animate bars
  requestAnimationFrame(() => {
    container.querySelectorAll('.chart-bar').forEach(bar => {
      const h = bar.style.height;
      bar.style.height = '4px';
      requestAnimationFrame(() => { bar.style.height = h; });
    });
  });
}

function renderSalesChart(ventas) {
  const container = document.getElementById('chartVentas');
  const months = getLastMonths(6);
  const data = months.map(m => {
    const filtered = ventas.filter(v => v.fecha.startsWith(m.key));
    return { label: m.label, value: filtered.reduce((s, v) => s + v.total, 0) };
  });

  const max = Math.max(...data.map(d => d.value), 1);
  container.innerHTML = data.map(d => `
    <div class="chart-bar-wrapper">
      <div class="chart-bar-value">${d.value > 0 ? '$' + d.value.toFixed(0) : ''}</div>
      <div class="chart-bar amber" style="height:${(d.value / max) * 180}px"></div>
      <div class="chart-bar-label">${d.label}</div>
    </div>
  `).join('');

  requestAnimationFrame(() => {
    container.querySelectorAll('.chart-bar').forEach(bar => {
      const h = bar.style.height;
      bar.style.height = '4px';
      requestAnimationFrame(() => { bar.style.height = h; });
    });
  });
}

function renderRecentActivity(cosechas, ventas) {
  const tbody = document.getElementById('recentActivity');
  const activities = [];

  cosechas.forEach(c => {
    activities.push({
      fecha: c.fecha,
      tipo: '🍯 Cosecha',
      desc: `${capitalize(c.producto)} de ${c.apiarioNombre}`,
      valor: `${c.cantidad} kg`,
      badgeClass: 'badge-gold'
    });
  });

  ventas.forEach(v => {
    activities.push({
      fecha: v.fecha,
      tipo: '💰 Venta',
      desc: `${capitalize(v.producto)} a ${v.clienteNombre}`,
      valor: `$${v.total.toFixed(2)}`,
      badgeClass: 'badge-green'
    });
  });

  activities.sort((a, b) => b.fecha.localeCompare(a.fecha));
  const recent = activities.slice(0, 8);

  if (recent.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty-state"><div class="icon">📋</div><p>No hay actividades recientes</p></td></tr>`;
    return;
  }

  tbody.innerHTML = recent.map(a => `
    <tr>
      <td>${formatDate(a.fecha)}</td>
      <td><span class="badge ${a.badgeClass}">${a.tipo}</span></td>
      <td>${a.desc}</td>
      <td class="td-bold">${a.valor}</td>
    </tr>
  `).join('');
}

// ===== FILTERS =====
function filterTable(section, query) {
  const tableMap = {
    apiarios: 'apiarioTable',
    cosechas: 'cosechaTable',
    ventas: 'ventaTable',
    clientes: 'clienteTable'
  };
  const tbody = document.getElementById(tableMap[section]);
  if (!tbody) return;
  const rows = tbody.querySelectorAll('tr[data-search]');
  const q = query.toLowerCase();
  rows.forEach(row => {
    const text = row.getAttribute('data-search') || '';
    row.style.display = text.includes(q) ? '' : 'none';
  });
}

let cosechaFilter = 'todas';
function filterCosechas(filter, btn) {
  cosechaFilter = filter;
  document.querySelectorAll('#page-cosechas .filter-chip').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderCosechas(filter);
}

let ventaFilter = 'todas';
function filterVentas(filter, btn) {
  ventaFilter = filter;
  document.querySelectorAll('#page-ventas .filter-chip').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderVentas(filter);
}

// ===== REFRESH =====
function refreshPage(page) {
  if (page === 'dashboard') updateDashboard();
  else if (page === 'apiarios') renderApiarios();
  else if (page === 'cosechas') renderCosechas(cosechaFilter);
  else if (page === 'ventas') renderVentas(ventaFilter);
  else if (page === 'clientes') renderClientes();
  else if (page === 'galeria') renderGallery();
}

// ===== EXPORT =====
async function exportData() {
  try {
    const exportObj = {};
    for (const store of STORES) {
      exportObj[store] = await dbGetAll(store);
    }

    // Remove photo data from export (too large)
    const exportClean = JSON.parse(JSON.stringify(exportObj));
    exportClean.fotos = exportClean.fotos.map(f => ({ ...f, data: '[FOTO]' }));
    if (exportClean.apiarios) exportClean.apiarios.forEach(a => { if (a.foto) a.foto = '[FOTO]'; });
    if (exportClean.cosechas) exportClean.cosechas.forEach(c => { if (c.foto) c.foto = '[FOTO]'; });

    const blob = new Blob([JSON.stringify(exportClean, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `apitrack_export_${new Date().toISOString().split('T')[0]}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Datos exportados correctamente');
  } catch (err) {
    showToast('Error al exportar datos', 'error');
  }
}

// ===== IMPORT =====
async function handleImportFile(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      let count = 0;
      for (const store of STORES) {
        if (Array.isArray(data[store])) {
          for (const item of data[store]) {
            delete item.id;
            await dbAdd(store, item);
            count++;
          }
        }
      }
      showToast(`Se importaron ${count} registros correctamente`);
      updateDashboard();
      refreshPage(currentPage);
    } catch (err) {
      console.error('Import error:', err);
      showToast('Error al importar el archivo JSON', 'error');
    }
  };
  reader.readAsText(file);
  event.target.value = '';
}

// ===== DEMO SEED DATA =====
async function seedDemoData(force = false) {
  const currentApiarios = await dbGetAll('apiarios');
  if (currentApiarios.length > 0 && !force) return;

  if (force) {
    for (const store of STORES) {
      const items = await dbGetAll(store);
      for (const item of items) {
        await dbDelete(store, item.id);
      }
    }
  }

  let samplePhotos = { apiarioPhoto: '', harvestPhoto: '' };
  try {
    const res = await fetch('sample_images.json');
    if (res.ok) {
      samplePhotos = await res.json();
    }
  } catch (e) {
    console.log('No external sample_images.json');
  }

  // 1. Apiarios
  const apiario1 = await dbAdd('apiarios', {
    nombre: 'Apiario Los Álamos',
    ubicacion: 'Valle de las Flores, Parcela 4',
    colmenas: 38,
    estado: 'activo',
    notas: 'Colmenas tipo Langstroth en óptimo desarrollo con floración abundante.',
    foto: samplePhotos.apiarioPhoto || '',
    fecha: '2026-08-15'
  });

  const apiario2 = await dbAdd('apiarios', {
    nombre: 'Apiario El Robledal',
    ubicacion: 'Falda de la Sierra, Km 18',
    colmenas: 24,
    estado: 'activo',
    notas: 'Zona de monte nativo con abundancia de floración de eucalipto y trébol.',
    foto: '',
    fecha: '2026-09-02'
  });

  const apiario3 = await dbAdd('apiarios', {
    nombre: 'Apiario San Lorenzo',
    ubicacion: 'Ruta 12, Puesto Viejo',
    colmenas: 16,
    estado: 'mantenimiento',
    notas: 'Cambio de reinas y refuerzo de cámaras de cría.',
    foto: '',
    fecha: '2026-09-20'
  });

  // 2. Clientes
  const cliente1 = await dbAdd('clientes', {
    nombre: 'Cooperativa Orgánica del Sur',
    telefono: '+54 9 11 4455-6677',
    email: 'compras@organicosur.com',
    direccion: 'Av. Corrientes 1420, CABA',
    notas: 'Cliente habitual. Compra miel fraccionada y tambores.',
    fecha: '2026-08-20'
  });

  const cliente2 = await dbAdd('clientes', {
    nombre: 'Dietética La Reina de Oro',
    telefono: '+54 9 351 2233-445',
    email: 'contacto@reinaoro.com.ar',
    direccion: 'Bv. San Juan 520, Córdoba',
    notas: 'Pide siempre polen fresco y miel cremosa.',
    fecha: '2026-08-25'
  });

  const cliente3 = await dbAdd('clientes', {
    nombre: 'Laboratorios Apiterapia Natural',
    telefono: '+54 9 261 8899-112',
    email: 'insumos@apiterapia.com',
    direccion: 'Carril Rodríguez Peña 890, Mendoza',
    notas: 'Compra propóleo de primera calidad y cera virgen.',
    fecha: '2026-09-10'
  });

  // Fechas dinámicas para los gráficos
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const pad = (n) => String(n).padStart(2, '0');
  const thisMonth = `${y}-${pad(m)}-10`;
  const prevMonth1 = `${y}-${pad(m > 1 ? m - 1 : 12)}-15`;
  const prevMonth2 = `${y}-${pad(m > 2 ? m - 2 : m + 10)}-20`;
  const prevMonth3 = `${y}-${pad(m > 3 ? m - 3 : m + 9)}-12`;

  // 3. Cosechas
  await dbAdd('cosechas', {
    fecha: prevMonth3,
    apiarioId: apiario1,
    apiarioNombre: 'Apiario Los Álamos',
    producto: 'miel',
    cantidad: 140,
    calidad: 'premium',
    notas: 'Primera cosecha de primavera. Humedad 17.2%, color ámbar claro muy aromático.',
    foto: samplePhotos.harvestPhoto || '',
    createdAt: new Date().toISOString()
  });

  await dbAdd('cosechas', {
    fecha: prevMonth2,
    apiarioId: apiario2,
    apiarioNombre: 'Apiario El Robledal',
    producto: 'miel',
    cantidad: 95,
    calidad: 'estandar',
    notas: 'Miel multifloral de monte, densidad excelente.',
    foto: '',
    createdAt: new Date().toISOString()
  });

  await dbAdd('cosechas', {
    fecha: prevMonth2,
    apiarioId: apiario1,
    apiarioNombre: 'Apiario Los Álamos',
    producto: 'cera',
    cantidad: 18,
    calidad: 'premium',
    notas: 'Cera de opérculo filtrada y purificada en lingotes limpios.',
    foto: '',
    createdAt: new Date().toISOString()
  });

  await dbAdd('cosechas', {
    fecha: prevMonth1,
    apiarioId: apiario1,
    apiarioNombre: 'Apiario Los Álamos',
    producto: 'propoleo',
    cantidad: 8.5,
    calidad: 'premium',
    notas: 'Propóleo cosechado con mallas plásticas. Alto contenido resinoso.',
    foto: '',
    createdAt: new Date().toISOString()
  });

  await dbAdd('cosechas', {
    fecha: prevMonth1,
    apiarioId: apiario2,
    apiarioNombre: 'Apiario El Robledal',
    producto: 'polen',
    cantidad: 22,
    calidad: 'premium',
    notas: 'Polen trampa cazapolen secado a baja temperatura.',
    foto: '',
    createdAt: new Date().toISOString()
  });

  await dbAdd('cosechas', {
    fecha: thisMonth,
    apiarioId: apiario1,
    apiarioNombre: 'Apiario Los Álamos',
    producto: 'miel',
    cantidad: 165,
    calidad: 'premium',
    notas: 'Pico de producción temporada de trébol. Extraída en sala habilitada.',
    foto: '',
    createdAt: new Date().toISOString()
  });

  // 4. Ventas
  await dbAdd('ventas', {
    fecha: prevMonth3,
    clienteId: cliente1,
    clienteNombre: 'Cooperativa Orgánica del Sur',
    producto: 'miel',
    cantidad: 100,
    precio: 4200,
    total: 420000,
    estado: 'pagada',
    notas: 'Entregado en envases de 1kg etiquetados con lote C-01.',
    createdAt: new Date().toISOString()
  });

  await dbAdd('ventas', {
    fecha: prevMonth2,
    clienteId: cliente2,
    clienteNombre: 'Dietética La Reina de Oro',
    producto: 'miel',
    cantidad: 50,
    precio: 4500,
    total: 225000,
    estado: 'pagada',
    notas: 'Frascos de vidrio hexagonales con precinto de seguridad.',
    createdAt: new Date().toISOString()
  });

  await dbAdd('ventas', {
    fecha: prevMonth2,
    clienteId: cliente3,
    clienteNombre: 'Laboratorios Apiterapia Natural',
    producto: 'cera',
    cantidad: 12,
    precio: 6500,
    total: 78000,
    estado: 'pagada',
    notas: 'Bloques de cera virgen grado cosmético.',
    createdAt: new Date().toISOString()
  });

  await dbAdd('ventas', {
    fecha: prevMonth1,
    clienteId: cliente3,
    clienteNombre: 'Laboratorios Apiterapia Natural',
    producto: 'propoleo',
    cantidad: 6,
    precio: 18000,
    total: 108000,
    estado: 'entregada',
    notas: 'Muestra analizada en laboratorio previa a la entrega.',
    createdAt: new Date().toISOString()
  });

  await dbAdd('ventas', {
    fecha: thisMonth,
    clienteId: cliente1,
    clienteNombre: 'Cooperativa Orgánica del Sur',
    producto: 'miel',
    cantidad: 120,
    precio: 4600,
    total: 552000,
    estado: 'pagada',
    notas: 'Entrega mensual de temporada alta.',
    createdAt: new Date().toISOString()
  });

  await dbAdd('ventas', {
    fecha: thisMonth,
    clienteId: cliente2,
    clienteNombre: 'Dietética La Reina de Oro',
    producto: 'polen',
    cantidad: 15,
    precio: 9000,
    total: 135000,
    estado: 'pendiente',
    notas: 'Pedido listo para despacho contra acreditación.',
    createdAt: new Date().toISOString()
  });

  if (samplePhotos.apiarioPhoto) {
    await dbAdd('fotos', {
      data: samplePhotos.apiarioPhoto,
      fecha: new Date().toISOString(),
      tipo: 'apiario'
    });
  }
  if (samplePhotos.harvestPhoto) {
    await dbAdd('fotos', {
      data: samplePhotos.harvestPhoto,
      fecha: new Date().toISOString(),
      tipo: 'cosecha'
    });
  }

  showToast(force ? 'Datos demo recargados con éxito' : 'Bienvenido a ApiTrack');
  updateDashboard();
  refreshPage(currentPage);
}

// ===== HELPERS =====
function formatDate(dateStr) {
  if (!dateStr) return '—';
  const parts = dateStr.split('-');
  if (parts.length >= 3) {
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
  }
  return dateStr;
}

function capitalize(str) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function truncate(str, len) {
  if (str.length <= len) return str;
  return str.substring(0, len) + '…';
}

function getLastMonths(n) {
  const months = [];
  const now = new Date();
  const monthNames = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: monthNames[d.getMonth()]
    });
  }
  return months;
}

// ===== PWA INSTALL =====
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
  document.getElementById('installBanner').classList.add('show');
});

function installPWA() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    deferredPrompt.userChoice.then(choice => {
      if (choice.outcome === 'accepted') {
        showToast('¡Aplicación instalada!', 'success');
      }
      deferredPrompt = null;
      document.getElementById('installBanner').classList.remove('show');
    });
  }
}

// ===== SERVICE WORKER =====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(() => console.log('SW registered'))
      .catch(err => console.log('SW registration failed:', err));
  });
}

// ===== INIT =====
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await openDB();
    const existing = await dbGetAll('apiarios');
    // Los datos demo solo se cargan la primera vez y nunca en un dispositivo con la sincronización activa
    const seededBefore = localStorage.getItem('apitrack_seeded') === '1';
    if (existing.length > 0) localStorage.setItem('apitrack_seeded', '1');
    const syncOn = localStorage.getItem('apitrack_sync_enabled') === '1';
    if (existing.length === 0 && !seededBefore && !syncOn) {
      localStorage.setItem('apitrack_seeded', '1');
      await seedDemoData(false);
    } else {
      updateDashboard();
      renderApiarios();
    }
    if (typeof startSync === 'function') startSync();
  } catch (err) {
    console.error('Init error:', err);
    showToast('Error al inicializar la base de datos', 'error');
  }
});

// Keyboard shortcut - Escape to close modals
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay.active').forEach(m => {
      m.classList.remove('active');
    });
    closePhotoViewer();
    stopCamera();
  }
});
