/* Stock Count PWA v2.0.0 — Pure Local (no Cloud sync, Barcode-as-Text invariant) */

// ============ Dexie schema (Local IndexedDB only) ============
const db = new Dexie('StockCountDB');
db.version(1).stores({
  sessions: '++id, name, org, warehouse, createdAt, updatedAt, status',
  items: '++id, sessionId, barcode, sku, [sessionId+barcode]',
  warehouses: '++id, &name',
  settings: '&key'
});
db.version(2).stores({
  sessions: '++id, name, org, warehouse, createdAt, updatedAt, status, cloudId',
  items: '++id, sessionId, barcode, sku, [sessionId+barcode], cloudId',
  warehouses: '++id, &name',
  settings: '&key',
  syncQueue: '++id, op, createdAt, retries',
});
// v3: drop cloud-only stores (keeps data, removes obsolete indexes)
db.version(3).stores({
  sessions: '++id, name, org, warehouse, createdAt, updatedAt, status',
  items: '++id, sessionId, barcode, sku, [sessionId+barcode]',
  warehouses: '++id, &name',
  settings: '&key',
  syncQueue: null,  // delete the syncQueue store
});

// ============ State ============
const state = {
  currentSessionId: null,
  currentItems: [],
  filter: { search: '', status: 'all', type: '', size: '', color: '' },
  page: 1, pageSize: 50, lastScanTime: null,
};

// ============ Helpers ============
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

function showView(name) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#view' + name).classList.add('active');
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function toast(msg, type) {
  type = type || 'info';
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toastStack').appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
function fmtNum(n) { if (n === null || n === undefined || n === '') return '0'; return Number(n).toLocaleString('en-US'); }
function todayStr() { const d = new Date(); const pad = n => String(n).padStart(2, '0'); return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate()); }
function orgBadgeClass(org) { if (org === 'CCO') return 'badge-cco'; if (org === 'CROCHET') return 'badge-crochet'; if (org === 'MTP') return 'badge-mtp'; return 'badge-other'; }
function orgLabel(org) { if (org === 'CCO') return 'CCO'; if (org === 'CROCHET') return 'Crochet'; if (org === 'MTP') return 'MTP'; return org; }

// === BARCODE TEXT INVARIANT (ADR-0002) ===
// String() preserves Number precision for integers up to 2^53 (covers EAN-13).
// Never use parseInt/Number/parseFloat on barcodes.
function normalizeBarcode(s) {
  if (s === null || s === undefined) return '';
  return String(s).trim().replace(/[\r\n\t]/g, '');
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function confirmModal(title, body, okText, okClass) {
  okText = okText || 'ตกลง'; okClass = okClass || 'primary';
  return new Promise((resolve) => {
    $('#genericModalTitle').textContent = title;
    $('#genericModalBody').innerHTML = body;
    const okBtn = $('#genericModalOk');
    okBtn.textContent = okText; okBtn.className = 'btn ' + okClass;
    $('#genericModal').classList.add('active');
    const close = (val) => {
      $('#genericModal').classList.remove('active');
      okBtn.onclick = null; $('#genericModalCancel').onclick = null; resolve(val);
    };
    okBtn.onclick = () => close(true);
    $('#genericModalCancel').onclick = () => close(false);
  });
}

function inputModal(title, label, defaultValue, placeholder, inputType) {
  defaultValue = defaultValue || ''; placeholder = placeholder || ''; inputType = inputType || 'text';
  return new Promise((resolve) => {
    $('#genericModalTitle').textContent = title;
    const id = 'mInput_' + Date.now();
    $('#genericModalBody').innerHTML =
      '<label for="' + id + '">' + label + '</label>' +
      '<input id="' + id + '" type="' + inputType + '" value="' + escapeHtml(defaultValue) + '" placeholder="' + escapeHtml(placeholder) + '" style="width:100%;padding:10px 12px;border:1px solid var(--border);border-radius:8px;font-size:14px" />';
    const okBtn = $('#genericModalOk');
    okBtn.textContent = 'ตกลง'; okBtn.className = 'btn primary';
    $('#genericModal').classList.add('active');
    const inp = document.getElementById(id);
    setTimeout(() => { inp.focus(); inp.select(); }, 50);
    const close = (val) => {
      $('#genericModal').classList.remove('active');
      okBtn.onclick = null; $('#genericModalCancel').onclick = null; inp.onkeydown = null;
      resolve(val);
      setTimeout(() => { if ($('#viewCount').classList.contains('active')) $('#barcodeInput').focus(); }, 100);
    };
    okBtn.onclick = () => close(inp.value);
    $('#genericModalCancel').onclick = () => close(null);
    inp.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(inp.value); }
      else if (e.key === 'Escape') { e.preventDefault(); close(null); }
    };
  });
}

// ============ Warehouses ============
const DEFAULT_WAREHOUSES = ['Shop', 'Co-Sign', 'Flood', 'Warehouse', 'Online'];

async function ensureDefaultWarehouses() {
  const count = await db.warehouses.count();
  if (count === 0) await db.warehouses.bulkAdd(DEFAULT_WAREHOUSES.map(name => ({ name })));
}
async function addWarehouse(name) {
  name = name.trim();
  if (!name) throw new Error('ชื่อคลังว่าง');
  try { await db.warehouses.add({ name }); }
  catch (e) { if (e.name === 'ConstraintError') throw new Error('มีคลังชื่อนี้แล้ว'); throw e; }
}
async function deleteWarehouse(id) { await db.warehouses.delete(id); }

async function refreshWarehouseSelect() {
  const list = await db.warehouses.orderBy('name').toArray();
  const sel = $('#newSessionWarehouse');
  sel.innerHTML = '';
  list.forEach(w => { const opt = document.createElement('option'); opt.value = w.name; opt.textContent = w.name; sel.appendChild(opt); });
}
async function renderWarehouseChips() {
  const list = await db.warehouses.orderBy('name').toArray();
  const container = $('#warehouseChips');
  container.innerHTML = '';
  if (list.length === 0) { container.innerHTML = '<div class="text-muted">ยังไม่มีคลัง</div>'; return; }
  list.forEach(w => {
    const chip = document.createElement('div');
    chip.className = 'chip';
    chip.innerHTML = '<span>' + escapeHtml(w.name) + '</span> <button title="ลบ" data-id="' + w.id + '">×</button>';
    chip.querySelector('button').onclick = async () => {
      if (await confirmModal('ลบคลัง?', 'ต้องการลบคลัง "<b>' + escapeHtml(w.name) + '</b>" ใช่หรือไม่?', 'ลบ', 'danger')) {
        await deleteWarehouse(w.id);
        renderWarehouseChips(); refreshWarehouseSelect();
        toast('ลบคลังเรียบร้อย', 'success');
      }
    };
    container.appendChild(chip);
  });
}

// ============ Excel Import (Barcode-as-Text rule: raw=true) ============
let parsedRows = null;

function parseExcelFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array' });
        const sheetName = wb.SheetNames.find(n => n.toLowerCase() === 'products') || wb.SheetNames[0];
        const ws = wb.Sheets[sheetName];
        // raw:true → cells return their actual JS type (Number stays Number, no scientific-notation string corruption)
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: true });
        resolve({ rows, sheetName });
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function normalizeRow(r) {
  const keys = {};
  Object.keys(r).forEach(k => keys[k.toLowerCase().trim()] = k);
  const pick = (...names) => {
    for (const n of names) {
      if (keys[n.toLowerCase()] !== undefined) {
        const v = r[keys[n.toLowerCase()]];
        if (v !== '' && v !== null && v !== undefined) return v;
      }
    }
    return '';
  };
  const num = (v) => {
    if (v === '' || v === null || v === undefined) return 0;
    const n = Number(String(v).replace(/,/g, ''));
    return isNaN(n) ? 0 : n;
  };
  return {
    // Barcode: ALWAYS string. Don't num()/parseInt. String() preserves Number precision.
    barcode: normalizeBarcode(pick('Barcode', 'barcode', 'EAN', 'UPC', 'Variant Barcode')),
    sku: String(pick('SKU', 'sku', 'Variant SKU') || '').trim(),
    title: String(pick('Title', 'Name', 'Product', 'ชื่อสินค้า', 'ชื่อ') || '').trim(),
    type: String(pick('Type', 'Product Type', 'ประเภท') || '').trim(),
    size: String(pick('Size', 'Variant', 'Option1 Value') || '').trim(),
    color: String(pick('Color', 'Colour', 'สี', 'Option2 Value') || '').trim(),
    vendor: String(pick('Vendor', 'Brand', 'แบรนด์') || '').trim(),
    price: num(pick('Price', 'Variant Price')),
    cost: num(pick('Cost', 'Variant Cost', 'ต้นทุน')),
    qtyInitial: num(pick('Qty', 'Quantity', 'Variant Inventory Qty', 'จำนวน', 'คงเหลือ')),
    qtyCounted: 0,
  };
}

async function handleFileSelected(file) {
  $('#filePreview').style.display = 'block';
  $('#filePreviewInfo').textContent = 'กำลังอ่านไฟล์...';
  try {
    const result = await parseExcelFile(file);
    const normalized = result.rows.map(normalizeRow).filter(r => r.barcode || r.sku);
    if (normalized.length === 0) {
      $('#filePreviewInfo').innerHTML = '⚠️ ไม่พบข้อมูลที่ถูกต้อง';
      $('#createSessionBtn').disabled = true; parsedRows = null; return;
    }
    parsedRows = normalized;
    const withBarcode = normalized.filter(r => r.barcode).length;
    const totalQty = normalized.reduce((s, r) => s + (r.qtyInitial || 0), 0);
    $('#filePreviewInfo').innerHTML = '✅ Sheet: <b>' + escapeHtml(result.sheetName) + '</b><br>จำนวน: <b>' + fmtNum(normalized.length) + '</b> รายการ (มี Barcode: <b>' + fmtNum(withBarcode) + '</b>)<br>ยอดตั้งต้นรวม: <b>' + fmtNum(totalQty) + '</b> ชิ้น';
    $('#createSessionBtn').disabled = false;
    if (!$('#newSessionName').value.trim()) $('#newSessionName').value = 'Stock Count ' + todayStr();
  } catch (err) {
    console.error(err);
    $('#filePreviewInfo').textContent = '❌ อ่านไฟล์ไม่สำเร็จ: ' + (err.message || err);
    $('#createSessionBtn').disabled = true; parsedRows = null;
  }
}

// ============ Excel Export helper (Barcode-as-Text rule) ============
// Force Barcode column cell type to 's' (string) and numFmt '@' (Text format)
// so Excel never converts back to scientific notation on round-trip.
function lockBarcodeColumnAsText(ws, headerName) {
  headerName = headerName || 'Barcode';
  if (!ws['!ref']) return;
  const range = XLSX.utils.decode_range(ws['!ref']);
  // Find Barcode column index from header row
  let barcodeCol = -1;
  for (let C = range.s.c; C <= range.e.c; C++) {
    const addr = XLSX.utils.encode_cell({ r: range.s.r, c: C });
    if (ws[addr] && String(ws[addr].v).trim().toLowerCase() === headerName.toLowerCase()) {
      barcodeCol = C; break;
    }
  }
  if (barcodeCol < 0) return;
  for (let R = range.s.r + 1; R <= range.e.r; R++) {
    const addr = XLSX.utils.encode_cell({ r: R, c: barcodeCol });
    if (ws[addr]) {
      ws[addr].t = 's';
      ws[addr].z = '@';
      ws[addr].v = String(ws[addr].v);
    }
  }
}

// ============ Session CRUD ============
async function createSession(meta) {
  const id = await db.sessions.add({
    name: meta.name, org: meta.org, warehouse: meta.warehouse, date: meta.date,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'active'
  });
  await db.items.bulkAdd(parsedRows.map(it => ({ ...it, sessionId: id })));
  return id;
}

async function loadSessionList() {
  const sessions = await db.sessions.orderBy('updatedAt').reverse().toArray();
  const container = $('#sessionListContainer');
  if (sessions.length === 0) {
    container.innerHTML = '<div class="empty-state"><div style="font-size:48px;margin-bottom:12px;opacity:0.5">📦</div><div>ยังไม่มี Session การนับ</div><div class="text-muted" style="font-size:13px;margin-top:6px">กด "สร้าง Session ใหม่" เพื่อเริ่มต้น</div></div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'session-grid';
  for (const s of sessions) {
    const items = await db.items.where('sessionId').equals(s.id).toArray();
    const total = items.length;
    const matched = items.filter(i => i.qtyCounted === i.qtyInitial && i.qtyInitial > 0).length;
    const totalInitial = items.reduce((sum, i) => sum + (i.qtyInitial || 0), 0);
    const totalCounted = items.reduce((sum, i) => sum + (i.qtyCounted || 0), 0);
    const pct = total > 0 ? Math.round((matched / total) * 100) : 0;
    const card = document.createElement('div');
    card.className = 'session-item';
    card.innerHTML = '<div><span class="org-badge ' + orgBadgeClass(s.org) + '">' + escapeHtml(orgLabel(s.org)) + '</span><span class="chip">🏬 ' + escapeHtml(s.warehouse) + '</span></div>' +
      '<div class="name">' + escapeHtml(s.name) + '</div>' +
      '<div class="meta">สร้างเมื่อ ' + new Date(s.createdAt).toLocaleString('th-TH', { hour12: false }) + '</div>' +
      '<div class="progress"><div class="progress-bar" style="width:' + pct + '%"></div></div>' +
      '<div class="stats"><div><b>' + fmtNum(matched) + '</b>/' + fmtNum(total) + ' ครบ (' + pct + '%)</div><div>นับ <b>' + fmtNum(totalCounted) + '</b>/' + fmtNum(totalInitial) + '</div></div>';
    card.onclick = () => openSession(s.id);
    grid.appendChild(card);
  }
  container.innerHTML = ''; container.appendChild(grid);
}

async function openSession(id) {
  state.currentSessionId = id;
  const s = await db.sessions.get(id);
  if (!s) { toast('ไม่พบ Session', 'error'); return; }
  state.currentItems = await db.items.where('sessionId').equals(id).toArray();
  $('#countSessionTitle').textContent = s.name;
  $('#countSessionMeta').innerHTML = '<span class="org-badge ' + orgBadgeClass(s.org) + '">' + escapeHtml(orgLabel(s.org)) + '</span> 🏬 ' + escapeHtml(s.warehouse) + ' · 📅 ' + escapeHtml(s.date || new Date(s.createdAt).toISOString().slice(0,10)) + ' · รายการทั้งหมด ' + fmtNum(state.currentItems.length) + ' รายการ';
  state.page = 1; state.filter = { search: '', status: 'all', type: '', size: '', color: '' };
  $('#searchInput').value = ''; $('#filterStatus').value = 'all';
  populateAttrFilters();
  renderTable(); renderStats();
  showView('Count');
  setTimeout(() => $('#barcodeInput').focus(), 100);
}

async function deleteCurrentSession() {
  if (!state.currentSessionId) return;
  const ok = await confirmModal('ลบ Session?', 'การลบจะไม่สามารถกู้คืนได้', 'ลบ', 'danger');
  if (!ok) return;
  await db.items.where('sessionId').equals(state.currentSessionId).delete();
  await db.sessions.delete(state.currentSessionId);
  state.currentSessionId = null;
  toast('ลบ Session เรียบร้อย', 'success');
  showView('Home'); loadSessionList();
}

async function resetCounts() {
  if (!state.currentSessionId) return;
  const ok = await confirmModal('รีเซ็ตจำนวนนับ?', 'จะรีเซ็ตจำนวนที่นับได้กลับเป็น 0', 'รีเซ็ต', 'danger');
  if (!ok) return;
  const items = await db.items.where('sessionId').equals(state.currentSessionId).toArray();
  for (const it of items) {
    if (it._notInMaster) await db.items.delete(it.id);
    else await db.items.update(it.id, { qtyCounted: 0 });
  }
  state.currentItems = await db.items.where('sessionId').equals(state.currentSessionId).toArray();
  renderTable(); renderStats();
  toast('รีเซ็ตเรียบร้อย', 'success');
}

async function touchSession() {
  if (!state.currentSessionId) return;
  await db.sessions.update(state.currentSessionId, { updatedAt: new Date().toISOString() });
}

// ============ Scanning ============
async function handleScan(rawCode) {
  const code = normalizeBarcode(rawCode);
  if (!code) return;
  if (!state.currentSessionId) { toast('กรุณาเลือก Session', 'error'); return; }
  // Lookup by [sessionId, barcode]
  const matches = await db.items.where('[sessionId+barcode]').equals([state.currentSessionId, code]).toArray();
  const target = matches[0] || null;
  state.lastScanTime = new Date();

  if (!target) {
    const newItem = {
      sessionId: state.currentSessionId, barcode: code, sku: '',
      title: '⚠️ Barcode ไม่อยู่ในไฟล์ตั้งต้น',
      type: '', size: '', color: '', vendor: '',
      price: 0, cost: 0, qtyInitial: 0, qtyCounted: 1, _notInMaster: true,
    };
    const id = await db.items.add(newItem);
    state.currentItems.push({ ...newItem, id });
    beepError();
    updateLastScanText(code, '❓ ไม่พบในไฟล์ตั้งต้น — เพิ่มเป็นรายการใหม่ +1');
    toast('❓ ไม่พบ Barcode ' + code + ' ในไฟล์ตั้งต้น', 'warning');
  } else {
    const item = await db.items.get(target.id);
    const newCount = (item.qtyCounted || 0) + 1;
    await db.items.update(target.id, { qtyCounted: newCount });
    const idx = state.currentItems.findIndex(i => String(i.id) === String(target.id));
    if (idx >= 0) state.currentItems[idx].qtyCounted = newCount;
    const remaining = target.qtyInitial - newCount;
    if (newCount === target.qtyInitial) {
      beepSuccess();
      updateLastScanText(code, '✅ ' + target.title + ' — ครบแล้ว ' + newCount + '/' + target.qtyInitial);
    } else if (newCount > target.qtyInitial) {
      beepWarn();
      updateLastScanText(code, '⚠️ ' + target.title + ' — นับเกิน! ' + newCount + '/' + target.qtyInitial);
    } else {
      beepOK();
      updateLastScanText(code, '📦 ' + target.title + ' — นับได้ ' + newCount + '/' + target.qtyInitial + ' (ขาดอีก ' + remaining + ')');
    }
  }
  touchSession();
  renderTable(); renderStats();
}

function updateLastScanText(code, msg) {
  $('#lastScanText').textContent = msg;
  $('#lastScanTime').textContent = code + ' · ' + new Date().toLocaleTimeString('th-TH', { hour12: false });
}

let audioCtx = null;
function beep(freq, duration, volume) {
  volume = volume || 0.1;
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination);
    osc.frequency.value = freq; osc.type = 'sine'; gain.gain.value = volume;
    osc.start(); setTimeout(() => osc.stop(), duration);
  } catch (e) {}
}
function beepOK() { beep(880, 80); }
function beepSuccess() { beep(660, 80); setTimeout(() => beep(990, 120), 90); }
function beepWarn() { beep(440, 80); setTimeout(() => beep(330, 200), 90); }
function beepError() { beep(220, 200); }

// ============ Render Table & Stats ============
function filterItems() {
  const search = state.filter.search.toLowerCase().trim();
  const status = state.filter.status;
  const fType = state.filter.type, fSize = state.filter.size, fColor = state.filter.color;
  return state.currentItems.filter(it => {
    if (search) {
      const hay = (it.barcode + ' ' + it.sku + ' ' + it.title + ' ' + it.type + ' ' + it.size + ' ' + (it.color || '') + ' ' + it.vendor).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (fType && (it.type || '') !== fType) return false;
    if (fSize && (it.size || '') !== fSize) return false;
    if (fColor && (it.color || '') !== fColor) return false;
    const counted = it.qtyCounted || 0, init = it.qtyInitial || 0;
    if (status === 'pending' && counted === init && init > 0) return false;
    if (status === 'pending' && (init === 0)) return false;
    if (status === 'matched' && !(counted === init && init > 0)) return false;
    if (status === 'over' && !(counted > init)) return false;
    if (status === 'under' && !(counted < init && counted > 0)) return false;
    if (status === 'not_started' && !(counted === 0 && init > 0)) return false;
    if (status === 'not_in_master' && !it._notInMaster) return false;
    return true;
  });
}

function populateAttrFilters() {
  const types = new Set(), sizes = new Set(), colors = new Set();
  state.currentItems.forEach(it => { if (it.type) types.add(it.type); if (it.size) sizes.add(it.size); if (it.color) colors.add(it.color); });
  fillFilterSelect('#filterType', 'Type', types);
  fillFilterSelect('#filterSize', 'Size', sizes);
  fillFilterSelect('#filterColor', 'Color', colors);
}
function fillFilterSelect(sel, label, valueSet) {
  const el = $(sel); if (!el) return;
  const current = el.value;
  const sorted = Array.from(valueSet).sort((a, b) => String(a).localeCompare(String(b), 'th'));
  el.innerHTML = '<option value="">' + label + ': ทั้งหมด</option>' + sorted.map(v => '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + '</option>').join('');
  if (sorted.includes(current)) el.value = current;
}

function rowStatus(it) {
  const counted = it.qtyCounted || 0, init = it.qtyInitial || 0;
  if (it._notInMaster) return { cls: 'over', label: '❓ ไม่อยู่ในไฟล์ตั้งต้น', statusCls: 'status-over' };
  if (init === 0 && counted === 0) return { cls: 'pending', label: 'ตั้งต้น 0', statusCls: 'status-pending' };
  if (counted === init) return { cls: 'matched', label: '✅ ครบ', statusCls: 'status-matched' };
  if (counted > init) return { cls: 'over', label: '⚠️ เกิน', statusCls: 'status-over' };
  if (counted === 0) return { cls: 'pending', label: 'ยังไม่ได้นับ', statusCls: 'status-pending' };
  return { cls: 'pending', label: 'ขาด', statusCls: 'status-under' };
}

function renderTable() {
  const filtered = filterItems();
  const totalPages = Math.max(1, Math.ceil(filtered.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  const slice = filtered.slice(start, start + state.pageSize);
  const tbody = $('#productTableBody');
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="11" class="text-center text-muted" style="padding:30px">ไม่พบรายการตามเงื่อนไข</td></tr>';
  } else {
    tbody.innerHTML = slice.map(it => {
      const counted = it.qtyCounted || 0, init = it.qtyInitial || 0, diff = counted - init;
      const st = rowStatus(it);
      const diffColor = diff === 0 ? 'var(--success)' : diff > 0 ? 'var(--danger)' : 'var(--warning)';
      const diffPrefix = diff > 0 ? '+' : '';
      return '<tr class="' + st.cls + '" data-id="' + it.id + '">' +
        '<td><span class="row-status ' + st.statusCls + '">' + st.label + '</span></td>' +
        '<td><code>' + escapeHtml(it.barcode) + '</code></td>' +
        '<td>' + escapeHtml(it.sku) + '</td>' +
        '<td class="title">' + escapeHtml(it.title) + '</td>' +
        '<td>' + escapeHtml(it.type) + '</td>' +
        '<td>' + escapeHtml(it.size) + '</td>' +
        '<td>' + escapeHtml(it.color || '') + '</td>' +
        '<td class="num">' + fmtNum(init) + '</td>' +
        '<td class="num"><b>' + fmtNum(counted) + '</b></td>' +
        '<td class="num" style="color:' + diffColor + '">' + diffPrefix + fmtNum(diff) + '</td>' +
        '<td>' +
          '<button class="btn sm" onclick="adjustQty(\'' + it.id + '\', 1)">+1</button> ' +
          '<button class="btn sm" onclick="adjustQty(\'' + it.id + '\', -1)">-1</button> ' +
          '<button class="btn sm" onclick="setQty(\'' + it.id + '\')">Set</button> ' +
          '<button class="btn sm" onclick="editItem(\'' + it.id + '\')" title="แก้ Barcode / Qty ตั้งต้น">✏️</button>' +
        '</td></tr>';
    }).join('');
  }
  $('#paginationBar').innerHTML = '<div>แสดง ' + fmtNum(Math.min(filtered.length, start+1)) + '–' + fmtNum(Math.min(filtered.length, start+state.pageSize)) + ' จาก ' + fmtNum(filtered.length) + ' (ทั้งหมด ' + fmtNum(state.currentItems.length) + ')</div>' +
    '<div style="display:flex;gap:6px;align-items:center"><button class="btn sm" onclick="changePage(-1)" ' + (state.page<=1?'disabled':'') + '>‹ ก่อน</button><span>หน้า ' + state.page + '/' + totalPages + '</span><button class="btn sm" onclick="changePage(1)" ' + (state.page>=totalPages?'disabled':'') + '>ถัดไป ›</button></div>';
}

function renderStats() {
  const items = state.currentItems;
  const total = items.length;
  const matched = items.filter(i => i.qtyCounted === i.qtyInitial && i.qtyInitial > 0).length;
  const pending = items.filter(i => (i.qtyCounted < i.qtyInitial) && i.qtyInitial > 0).length;
  const over = items.filter(i => i.qtyCounted > i.qtyInitial).length;
  const notInMaster = items.filter(i => i._notInMaster).length;
  const totalInit = items.reduce((s, i) => s + (i.qtyInitial || 0), 0);
  const totalCount = items.reduce((s, i) => s + (i.qtyCounted || 0), 0);
  const pct = total > 0 ? Math.round((matched / total) * 100) : 0;
  $('#statsRow').innerHTML = '<div class="stat-card info"><div class="label">ความคืบหน้า</div><div class="value">' + pct + '%</div><div class="sub">' + fmtNum(matched) + '/' + fmtNum(total) + '</div></div>' +
    '<div class="stat-card success"><div class="label">✅ ครบ</div><div class="value">' + fmtNum(matched) + '</div><div class="sub">รายการ</div></div>' +
    '<div class="stat-card warning"><div class="label">⏳ ขาด</div><div class="value">' + fmtNum(pending) + '</div><div class="sub">รายการ</div></div>' +
    '<div class="stat-card danger"><div class="label">⚠️ เกิน / ไม่ตรง</div><div class="value">' + fmtNum(over + notInMaster) + '</div><div class="sub">' + fmtNum(over) + ' เกิน · ' + fmtNum(notInMaster) + ' ไม่ตรง</div></div>' +
    '<div class="stat-card"><div class="label">ยอดรวม</div><div class="value">' + fmtNum(totalCount) + '<small style="font-size:14px;color:var(--text-muted)"> / ' + fmtNum(totalInit) + '</small></div><div class="sub">นับได้ / ตั้งต้น</div></div>';
}

window.changePage = (delta) => { state.page = Math.max(1, state.page + delta); renderTable(); };
window.adjustQty = async (id, delta) => {
  const it = state.currentItems.find(i => String(i.id) === String(id));
  if (!it) return;
  const newQty = Math.max(0, (it.qtyCounted || 0) + delta);
  await db.items.update(it.id, { qtyCounted: newQty });
  it.qtyCounted = newQty;
  touchSession();
  renderTable(); renderStats();
  setTimeout(() => $('#barcodeInput').focus(), 50);
};
window.setQty = async (id) => {
  const it = state.currentItems.find(i => String(i.id) === String(id));
  if (!it) return;
  const input = await inputModal('กำหนดจำนวนนับ', '<b>' + escapeHtml(it.title) + '</b><br><small style="color:var(--text-muted)">Barcode: ' + escapeHtml(it.barcode) + ' · ตั้งต้น: ' + it.qtyInitial + '</small>', String(it.qtyCounted || 0), 'จำนวนนับ', 'number');
  if (input === null) return;
  const n = parseInt(input, 10);
  if (isNaN(n) || n < 0) { toast('ใส่ตัวเลขที่ถูกต้อง', 'error'); return; }
  await db.items.update(it.id, { qtyCounted: n });
  it.qtyCounted = n;
  touchSession();
  renderTable(); renderStats();
};
window.editItem = async (id) => {
  const it = state.currentItems.find(i => String(i.id) === String(id));
  if (!it) return;
  $('#editItemSubtitle').innerHTML = 'SKU: <b>' + escapeHtml(it.sku || '-') + '</b> · นับได้ปัจจุบัน: <b>' + (it.qtyCounted || 0) + '</b>';
  $('#editItemSku').value = it.sku || '';
  $('#editItemTitle').value = it.title || '';
  $('#editItemBarcode').value = it.barcode || '';
  $('#editItemQtyInitial').value = it.qtyInitial || 0;
  $('#editItemModal').classList.add('active');
  window._editingItemId = id;
  setTimeout(() => $('#editItemBarcode').focus(), 50);
};
async function saveEditItem() {
  const id = window._editingItemId; if (!id) return;
  const it = state.currentItems.find(i => String(i.id) === String(id));
  if (!it) return;
  const newBarcode = normalizeBarcode($('#editItemBarcode').value);
  const newQtyInitial = parseInt($('#editItemQtyInitial').value, 10);
  if (isNaN(newQtyInitial) || newQtyInitial < 0) { toast('จำนวนตั้งต้นต้องเป็นตัวเลข ≥ 0', 'error'); return; }
  if (newBarcode && newBarcode !== it.barcode) {
    const dup = state.currentItems.find(i => String(i.id) !== String(id) && i.barcode === newBarcode);
    if (dup) { toast('Barcode นี้ซ้ำกับรายการ: ' + (dup.title || dup.sku), 'error'); return; }
  }
  await db.items.update(it.id, { barcode: newBarcode, qtyInitial: newQtyInitial });
  it.barcode = newBarcode;
  it.qtyInitial = newQtyInitial;
  touchSession();
  renderTable(); renderStats();
  closeEditItemModal();
  toast('บันทึกเรียบร้อย', 'success');
}
function closeEditItemModal() {
  $('#editItemModal').classList.remove('active');
  window._editingItemId = null;
  setTimeout(() => { if ($('#viewCount').classList.contains('active')) $('#barcodeInput').focus(); }, 100);
}

// ============ Excel Export (with Barcode-as-Text invariant) ============
async function exportSession() {
  if (!state.currentSessionId) return;
  const s = await db.sessions.get(state.currentSessionId);
  const items = await db.items.where('sessionId').equals(state.currentSessionId).toArray();
  const exportRows = items.map(it => {
    const counted = it.qtyCounted || 0, init = it.qtyInitial || 0, diff = counted - init;
    let status;
    if (it._notInMaster) status = 'NOT_IN_MASTER';
    else if (init === 0 && counted === 0) status = 'ZERO';
    else if (counted === init) status = 'MATCHED';
    else if (counted > init) status = 'OVER';
    else if (counted === 0) status = 'NOT_STARTED';
    else status = 'UNDER';
    return {
      'Barcode': it.barcode, 'SKU': it.sku, 'Title': it.title, 'Type': it.type, 'Size': it.size, 'Color': it.color || '',
      'Vendor': it.vendor, 'Price': it.price, 'Cost': it.cost,
      'Qty Initial': init, 'Qty Counted': counted, 'Difference': diff, 'Status': status,
    };
  });
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(exportRows);
  ws['!cols'] = [{wch:16},{wch:14},{wch:40},{wch:12},{wch:18},{wch:14},{wch:14},{wch:10},{wch:10},{wch:11},{wch:12},{wch:12},{wch:14}];
  lockBarcodeColumnAsText(ws, 'Barcode');
  XLSX.utils.book_append_sheet(wb, ws, 'Stock Count');
  // Summary
  const total = items.length;
  const matched = items.filter(i => i.qtyCounted === i.qtyInitial && i.qtyInitial > 0).length;
  const pending = items.filter(i => (i.qtyCounted < i.qtyInitial) && i.qtyInitial > 0).length;
  const over = items.filter(i => i.qtyCounted > i.qtyInitial && !i._notInMaster).length;
  const notInMaster = items.filter(i => i._notInMaster).length;
  const totalInit = items.reduce((s, i) => s + (i.qtyInitial || 0), 0);
  const totalCount = items.reduce((s, i) => s + (i.qtyCounted || 0), 0);
  const summary = [
    { Field: 'Session Name', Value: s.name }, { Field: 'Organization', Value: orgLabel(s.org) },
    { Field: 'Warehouse', Value: s.warehouse }, { Field: 'Date', Value: s.date || '' },
    { Field: 'Created At', Value: s.createdAt }, { Field: 'Updated At', Value: s.updatedAt },
    { Field: 'Exported At', Value: new Date().toISOString() }, { Field: '', Value: '' },
    { Field: 'Total Items', Value: total }, { Field: 'Matched', Value: matched },
    { Field: 'Pending', Value: pending }, { Field: 'Over', Value: over },
    { Field: 'Not in Master', Value: notInMaster }, { Field: '', Value: '' },
    { Field: 'Total Qty Initial', Value: totalInit }, { Field: 'Total Qty Counted', Value: totalCount },
    { Field: 'Difference', Value: totalCount - totalInit },
  ];
  const wsSum = XLSX.utils.json_to_sheet(summary);
  wsSum['!cols'] = [{wch:30}, {wch:30}];
  XLSX.utils.book_append_sheet(wb, wsSum, 'Summary');
  const safeName = (s.name || 'StockCount').replace(/[\\\/:*?"<>|]/g, '_');
  const filename = safeName + '_' + orgLabel(s.org) + '_' + s.warehouse + '_' + todayStr() + '.xlsx';
  XLSX.writeFile(wb, filename);
  toast('Export สำเร็จ: ' + filename, 'success');
}

// ============ Settings ============
async function showStorageInfo() {
  try {
    const sessions = await db.sessions.count();
    const items = await db.items.count();
    let est = '';
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      est = ' (' + (e.usage / 1024 / 1024).toFixed(2) + ' MB ใช้จาก ' + (e.quota / 1024 / 1024).toFixed(0) + ' MB)';
    }
    $('#storageInfo').innerHTML = '💾 Pure Local — มี <b>' + sessions + '</b> Sessions และ <b>' + items + '</b> รายการ' + est;
  } catch (e) { $('#storageInfo').textContent = 'ไม่สามารถตรวจสอบได้: ' + (e.message || e); }
}

async function clearAllData() {
  const ok = await confirmModal('ล้างข้อมูลทั้งหมด?', 'จะลบ <b>ทุก Session และทุกรายการใน Browser นี้</b><br><small>การกระทำนี้ไม่สามารถย้อนกลับได้</small>', 'ล้างข้อมูลทั้งหมด', 'danger');
  if (!ok) return;
  await db.items.clear(); await db.sessions.clear();
  toast('ล้างข้อมูลเรียบร้อย', 'success');
  showStorageInfo(); loadSessionList(); showView('Home');
}

// ============ Goods Receive (in-memory, no persistence) ============
const receiveState = {
  masterByBarcode: new Map(), masterBySku: new Map(), masterCount: 0,
  scanned: new Map(), filter: { search: '', status: 'all' },
};

function makeCode(sku, size) {
  const s = (sku || '').trim(), sz = (size || '').trim();
  if (s && sz) return s + '_' + sz;
  return s || sz || '';
}

function showReceiveView() {
  renderReceiveView();
  showView('Receive');
  if (receiveState.masterByBarcode.size > 0) setTimeout(() => $('#receiveBarcodeInput').focus(), 100);
}

function renderReceiveView() {
  const hasMaster = receiveState.masterByBarcode.size > 0 || receiveState.masterBySku.size > 0;
  $('#receiveUploadStep').style.display = hasMaster ? 'none' : 'block';
  $('#receiveScanStep').style.display = hasMaster ? 'block' : 'none';
  if (hasMaster) {
    renderReceiveTable(); renderReceiveStats();
    $('#receiveMasterStat').textContent = '📋 Master โหลดแล้ว: ' + receiveState.masterCount + ' รายการ · มี Barcode: ' + receiveState.masterByBarcode.size;
  }
}

async function handleReceiveMasterFile(file) {
  $('#receiveMasterInfo').style.display = 'block';
  $('#receiveMasterInfoText').textContent = 'กำลังอ่านไฟล์...';
  try {
    const { rows, sheetName } = await parseExcelFile(file);
    receiveState.masterByBarcode.clear(); receiveState.masterBySku.clear();
    let count = 0, withBarcode = 0;
    rows.forEach(r => {
      const keys = {}; Object.keys(r).forEach(k => keys[k.toLowerCase().trim()] = k);
      const pick = (...names) => { for (const n of names) { if (keys[n.toLowerCase()] !== undefined) { const v = r[keys[n.toLowerCase()]]; if (v !== '' && v !== null && v !== undefined) return v; } } return ''; };
      // Barcode goes through normalizeBarcode (string invariant)
      const barcode = normalizeBarcode(pick('Variant Barcode', 'Barcode', 'barcode', 'EAN', 'UPC'));
      const sku = String(pick('Variant SKU', 'SKU', 'sku') || '').trim();
      const size = String(pick('Option1 Value', 'Size', 'size', 'Variant') || '').trim();
      const brand = String(pick('Vendor', 'brand', 'Brand', 'แบรนด์') || '').trim();
      const name = String(pick('Title', 'Name', 'Product', 'ชื่อสินค้า') || '').trim();
      if (barcode || sku) {
        const item = { barcode, sku, size, brand, name };
        if (barcode) { receiveState.masterByBarcode.set(barcode, item); withBarcode++; }
        if (sku && !receiveState.masterBySku.has(sku)) receiveState.masterBySku.set(sku, item);
        count++;
      }
    });
    receiveState.masterCount = count;
    if (count === 0) {
      $('#receiveMasterInfoText').innerHTML = '⚠️ ไม่พบข้อมูลใน Sheet "' + escapeHtml(sheetName) + '"';
      return;
    }
    $('#receiveMasterInfoText').innerHTML = '✅ Sheet: <b>' + escapeHtml(sheetName) + '</b><br>Master: <b>' + count + '</b> รายการ (Barcode: <b>' + withBarcode + '</b>)';
    toast('โหลด Master สำเร็จ ' + count + ' รายการ', 'success');
    setTimeout(() => { renderReceiveView(); setTimeout(() => $('#receiveBarcodeInput').focus(), 100); }, 600);
  } catch (e) {
    console.error(e);
    $('#receiveMasterInfoText').textContent = '❌ อ่านไฟล์ไม่สำเร็จ: ' + (e.message || e);
  }
}

async function handleReceiveScan(rawCode) {
  const code = normalizeBarcode(rawCode);
  if (!code) return;
  let master = receiveState.masterByBarcode.get(code);
  if (!master) master = receiveState.masterBySku.get(code);
  const existing = receiveState.scanned.get(code);
  if (existing) {
    existing.qty++;
    beepOK();
    updateReceiveLastScan(code, '📦 ' + (existing.name || '-') + ' — รวม ' + existing.qty + ' ชิ้น');
  } else if (master) {
    const item = Object.assign({}, master, { barcode: master.barcode || code, qty: 1, found: true, code: makeCode(master.sku, master.size) });
    receiveState.scanned.set(code, item);
    beepSuccess();
    updateReceiveLastScan(code, '✅ ' + (item.name || '-') + ' · ' + (item.size || '-') + ' (ชิ้นแรก)');
  } else {
    receiveState.scanned.set(code, { barcode: code, sku: '', size: '', brand: '', name: '⚠️ ไม่พบใน Master', code: '', qty: 1, found: false });
    beepError();
    updateReceiveLastScan(code, '❓ Barcode ไม่อยู่ใน Master');
    toast('❓ Barcode ' + code + ' ไม่อยู่ใน Master', 'warning');
  }
  renderReceiveTable(); renderReceiveStats();
}

function updateReceiveLastScan(code, msg) {
  $('#receiveLastScanText').textContent = msg;
  $('#receiveLastScanTime').textContent = code + ' · ' + new Date().toLocaleTimeString('th-TH', { hour12: false });
}

function filterReceiveItems() {
  const search = receiveState.filter.search.toLowerCase().trim();
  const status = receiveState.filter.status;
  return Array.from(receiveState.scanned.values()).filter(it => {
    if (search) {
      const code = it.code || makeCode(it.sku, it.size);
      const hay = (it.barcode + ' ' + it.sku + ' ' + it.name + ' ' + it.size + ' ' + it.brand + ' ' + code).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (status === 'found' && !it.found) return false;
    if (status === 'not_found' && it.found) return false;
    return true;
  });
}

function renderReceiveTable() {
  const items = filterReceiveItems();
  const tbody = $('#receiveTableBody');
  if (items.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted" style="padding:30px">ยังไม่มีรายการ — ยิง Barcode เพื่อเริ่ม</td></tr>';
    return;
  }
  tbody.innerHTML = items.map((it, idx) => {
    const cls = it.found ? 'matched' : 'over';
    const code = it.code || makeCode(it.sku, it.size);
    return '<tr class="' + cls + '">' +
      '<td>' + (idx + 1) + '</td>' +
      '<td><code>' + escapeHtml(it.barcode) + '</code></td>' +
      '<td>' + escapeHtml(it.sku || '-') + '</td>' +
      '<td>' + escapeHtml(it.size || '-') + '</td>' +
      '<td>' + escapeHtml(it.brand || '-') + '</td>' +
      '<td class="title">' + escapeHtml(it.name || '-') + '</td>' +
      '<td><code>' + escapeHtml(code || '-') + '</code></td>' +
      '<td class="num"><b>' + it.qty + '</b></td>' +
      '<td>' +
        '<button class="btn sm" onclick="receiveAdjust(\'' + it.barcode + '\', 1)">+1</button> ' +
        '<button class="btn sm" onclick="receiveAdjust(\'' + it.barcode + '\', -1)">-1</button> ' +
        '<button class="btn sm danger" onclick="receiveRemove(\'' + it.barcode + '\')">🗑</button>' +
      '</td></tr>';
  }).join('');
}

function renderReceiveStats() {
  const items = Array.from(receiveState.scanned.values());
  const total = items.length;
  const totalQty = items.reduce((s, i) => s + i.qty, 0);
  const found = items.filter(i => i.found).length;
  const notFound = total - found;
  $('#receiveStatsRow').innerHTML =
    '<div class="stat-card info"><div class="label">รวมรายการ</div><div class="value">' + total + '</div><div class="sub">SKU / Barcode</div></div>' +
    '<div class="stat-card success"><div class="label">✅ ยอดรวม</div><div class="value">' + totalQty + '</div><div class="sub">ชิ้น</div></div>' +
    '<div class="stat-card success"><div class="label">ตรง Master</div><div class="value">' + found + '</div><div class="sub">รายการ</div></div>' +
    '<div class="stat-card danger"><div class="label">⚠️ ไม่ตรง</div><div class="value">' + notFound + '</div><div class="sub">รายการ</div></div>';
}

window.receiveAdjust = (barcode, delta) => {
  const it = receiveState.scanned.get(barcode); if (!it) return;
  it.qty = Math.max(0, it.qty + delta);
  if (it.qty === 0) receiveState.scanned.delete(barcode);
  renderReceiveTable(); renderReceiveStats();
  setTimeout(() => $('#receiveBarcodeInput').focus(), 50);
};
window.receiveRemove = async (barcode) => {
  const it = receiveState.scanned.get(barcode); if (!it) return;
  const ok = await confirmModal('ลบรายการ?', 'ลบ "<b>' + escapeHtml(it.name || it.barcode) + '</b>"', 'ลบ', 'danger');
  if (!ok) return;
  receiveState.scanned.delete(barcode);
  renderReceiveTable(); renderReceiveStats();
};

async function exportReceive() {
  if (receiveState.scanned.size === 0) { toast('ยังไม่มีรายการ', 'warning'); return; }
  const items = Array.from(receiveState.scanned.values());
  const detailRows = [];
  let no = 1;
  items.forEach(it => {
    const code = it.code || makeCode(it.sku, it.size);
    for (let q = 0; q < it.qty; q++) {
      detailRows.push({ 'No': no++, 'Barcode': it.barcode, 'SKU': it.sku, 'Size': it.size, 'Brand': it.brand, 'Name': it.name, 'Code': code, 'QT': 1 });
    }
  });
  const summaryRows = items.map(it => ({
    'SKU': it.sku, 'Name': it.name, 'Brand': it.brand, 'Code': it.code || makeCode(it.sku, it.size),
    'Size': it.size, 'Barcode': it.barcode, 'Total': it.qty, 'Status': it.found ? 'OK' : 'NOT_IN_MASTER',
  }));
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(detailRows);
  ws1['!cols'] = [{wch:6},{wch:16},{wch:14},{wch:12},{wch:14},{wch:40},{wch:22},{wch:6}];
  lockBarcodeColumnAsText(ws1, 'Barcode');
  XLSX.utils.book_append_sheet(wb, ws1, 'Check');
  const ws2 = XLSX.utils.json_to_sheet(summaryRows);
  ws2['!cols'] = [{wch:14},{wch:40},{wch:14},{wch:22},{wch:12},{wch:16},{wch:8},{wch:16}];
  lockBarcodeColumnAsText(ws2, 'Barcode');
  XLSX.utils.book_append_sheet(wb, ws2, 'Summary');
  const filename = 'รับสินค้าเข้า_' + todayStr() + '.xlsx';
  XLSX.writeFile(wb, filename);
  toast('Export สำเร็จ: ' + filename + ' (' + detailRows.length + ' ชิ้น / ' + summaryRows.length + ' รายการ)', 'success');
}

async function clearReceive() {
  if (receiveState.scanned.size === 0) { toast('ไม่มีรายการ', 'warning'); return; }
  const ok = await confirmModal('ล้างทั้งหมด?', 'ลบ <b>' + receiveState.scanned.size + '</b> รายการ', 'ล้าง', 'danger');
  if (!ok) return;
  receiveState.scanned.clear();
  renderReceiveTable(); renderReceiveStats();
  toast('ล้างเรียบร้อย', 'success');
}

function changeReceiveMaster() {
  const reset = () => {
    receiveState.masterByBarcode.clear(); receiveState.masterBySku.clear(); receiveState.scanned.clear();
    $('#receiveMasterInfo').style.display = 'none'; $('#receiveFileInput').value = '';
    renderReceiveView();
  };
  if (receiveState.scanned.size > 0) {
    confirmModal('เปลี่ยน Master?', 'จะล้างรายการที่สแกนไว้ ' + receiveState.scanned.size + ' รายการ', 'เปลี่ยน', 'danger').then(ok => { if (ok) reset(); });
  } else reset();
}

function wireReceiveEvents() {
  $('#receiveDropZone').addEventListener('click', () => $('#receiveFileInput').click());
  $('#receiveFileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleReceiveMasterFile(e.target.files[0]); });
  $('#receiveDropZone').addEventListener('dragover', (e) => { e.preventDefault(); $('#receiveDropZone').classList.add('drag-over'); });
  $('#receiveDropZone').addEventListener('dragleave', () => $('#receiveDropZone').classList.remove('drag-over'));
  $('#receiveDropZone').addEventListener('drop', (e) => {
    e.preventDefault(); $('#receiveDropZone').classList.remove('drag-over');
    if (e.dataTransfer.files[0]) handleReceiveMasterFile(e.dataTransfer.files[0]);
  });
  $('#receiveBarcodeInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const code = $('#receiveBarcodeInput').value;
      if (code.trim()) handleReceiveScan(code);
      $('#receiveBarcodeInput').value = '';
    }
  });
  $('#receiveOpenCameraBtn').onclick = () => openCameraScanner();
  $('#receiveExportBtn').onclick = exportReceive;
  $('#receiveClearBtn').onclick = clearReceive;
  $('#receiveChangeMasterBtn').onclick = changeReceiveMaster;
  $('#receiveSearchInput').addEventListener('input', (e) => { receiveState.filter.search = e.target.value; renderReceiveTable(); });
  $('#receiveFilterStatus').addEventListener('change', (e) => { receiveState.filter.status = e.target.value; renderReceiveTable(); });
}

// ============ Camera Scanner (works on HTTPS; gracefully fails on file://) ============
let cameraScanner = null, cameraDevices = [], cameraCurrentIdx = 0;
let cameraLastCode = '', cameraLastCodeTime = 0;

async function openCameraScanner() {
  if (!window.Html5Qrcode) { toast('Camera library not loaded', 'error'); return; }
  $('#cameraOverlay').classList.add('active');
  $('#cameraStatus').textContent = 'กำลังขอสิทธิ์เข้าถึงกล้อง...';
  $('#cameraLastScan').textContent = 'ยังไม่มีการสแกน';
  try {
    cameraDevices = await Html5Qrcode.getCameras();
    if (!cameraDevices || cameraDevices.length === 0) {
      $('#cameraStatus').textContent = '❌ ไม่พบกล้อง';
      toast('ไม่พบกล้อง — file:// ไม่รองรับ (ต้อง HTTPS)', 'error'); return;
    }
    const backIdx = cameraDevices.findIndex(d => /back|rear|environment/i.test(d.label || ''));
    cameraCurrentIdx = backIdx >= 0 ? backIdx : 0;
    await startCameraOnDevice(cameraDevices[cameraCurrentIdx].id);
  } catch (e) {
    console.error('Camera error:', e);
    $('#cameraStatus').textContent = '❌ ' + (e.message || e);
    toast('เปิดกล้องไม่ได้ — ตรวจ permission หรือใช้ USB scanner แทน', 'error');
  }
}

async function startCameraOnDevice(deviceId) {
  try {
    if (cameraScanner) { try { await cameraScanner.stop(); } catch(e){} cameraScanner.clear(); cameraScanner = null; }
    cameraScanner = new Html5Qrcode('cameraReader', { verbose: false });
    const formats = [
      Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
      Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.UPC_E,
      Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
      Html5QrcodeSupportedFormats.CODE_93, Html5QrcodeSupportedFormats.ITF,
      Html5QrcodeSupportedFormats.CODABAR, Html5QrcodeSupportedFormats.QR_CODE
    ];
    const config = { fps: 10, qrbox: (vw, vh) => ({ width: Math.min(vw, 320), height: Math.min(vh, 200) }), formatsToSupport: formats, aspectRatio: 1.333 };
    await cameraScanner.start(deviceId, config, onCameraScanSuccess, () => {});
    $('#cameraStatus').textContent = '✅ พร้อมสแกน — เล็งกล้องไปที่ Barcode';
  } catch (e) {
    console.error('Start camera failed:', e);
    $('#cameraStatus').textContent = '❌ ' + (e.message || e);
  }
}

async function onCameraScanSuccess(decoded) {
  const now = Date.now();
  if (decoded === cameraLastCode && now - cameraLastCodeTime < 1500) return;
  cameraLastCode = decoded; cameraLastCodeTime = now;
  $('#cameraLastScan').textContent = '🎯 ' + decoded + ' · ' + new Date().toLocaleTimeString('th-TH', { hour12: false });
  if ($('#viewReceive').classList.contains('active')) await handleReceiveScan(decoded);
  else await handleScan(decoded);
  const continuous = $('#continuousScanChk').checked;
  if (!continuous) await closeCameraScanner();
}

async function closeCameraScanner() {
  if (cameraScanner) {
    try { await cameraScanner.stop(); } catch(e){}
    try { cameraScanner.clear(); } catch(e){}
    cameraScanner = null;
  }
  $('#cameraOverlay').classList.remove('active');
  cameraLastCode = '';
  setTimeout(() => $('#barcodeInput').focus(), 100);
}

async function switchCamera() {
  if (!cameraDevices || cameraDevices.length < 2) { toast('มีกล้องเพียงตัวเดียว', 'warning'); return; }
  cameraCurrentIdx = (cameraCurrentIdx + 1) % cameraDevices.length;
  await startCameraOnDevice(cameraDevices[cameraCurrentIdx].id);
}

// ============ Batch Import (paper → Excel → upload counts) ============
let batchParsedRows = null, batchMatchPreview = null;

function openBatchImport() {
  if (!state.currentSessionId) { toast('กรุณาเปิด Session ก่อน', 'error'); return; }
  batchParsedRows = null; batchMatchPreview = null;
  $('#batchStep1').style.display = 'block';
  $('#batchStep2').style.display = 'none';
  $('#batchBackBtn').style.display = 'none';
  $('#batchApplyBtn').style.display = 'none';
  $('#batchApplyBtn').disabled = true;
  $('#batchFileInput').value = '';
  $('#batchImportModal').classList.add('active');
}
function closeBatchImport() {
  $('#batchImportModal').classList.remove('active');
  batchParsedRows = null; batchMatchPreview = null;
}
async function handleBatchFile(file) {
  try {
    const result = await parseExcelFile(file);
    const rows = result.rows.map(r => {
      const keys = {}; Object.keys(r).forEach(k => keys[k.toLowerCase().trim()] = k);
      const pick = (...names) => { for (const n of names) { if (keys[n.toLowerCase()] !== undefined) { const v = r[keys[n.toLowerCase()]]; if (v !== '' && v !== null && v !== undefined) return v; } } return ''; };
      const num = (v) => { if (v === '' || v === null || v === undefined) return null; const n = Number(String(v).replace(/,/g, '')); return isNaN(n) ? null : n; };
      return {
        barcode: normalizeBarcode(pick('Barcode', 'barcode', 'EAN', 'UPC')),
        sku: String(pick('SKU', 'sku', 'Variant SKU') || '').trim(),
        qty: num(pick('Qty Counted', 'qty_counted', 'นับได้', 'Counted', 'Qty', 'Quantity', 'จำนวน')),
      };
    }).filter(r => r.barcode || r.sku);
    if (rows.length === 0) { toast('ไม่พบข้อมูล', 'error'); return; }
    batchParsedRows = rows;
    await refreshBatchPreview();
    $('#batchStep1').style.display = 'none';
    $('#batchStep2').style.display = 'block';
    $('#batchBackBtn').style.display = 'inline-flex';
    $('#batchApplyBtn').style.display = 'inline-flex';
  } catch (e) { console.error(e); toast('อ่านไฟล์ไม่สำเร็จ: ' + (e.message || e), 'error'); }
}
async function refreshBatchPreview() {
  if (!batchParsedRows) return;
  const matchBy = $('#batchMatchSelect').value || 'barcode';
  const mode = $('#batchModeSelect').value || 'replace';
  const byBarcode = new Map(), bySku = new Map();
  state.currentItems.forEach(it => {
    if (it.barcode) byBarcode.set(it.barcode, it);
    if (it.sku) { if (!bySku.has(it.sku)) bySku.set(it.sku, []); bySku.get(it.sku).push(it); }
  });
  const agg = new Map();
  batchParsedRows.forEach(r => {
    const key = matchBy === 'barcode' ? r.barcode : r.sku;
    if (!key) return;
    const cur = agg.get(key) || { key, barcode: r.barcode, sku: r.sku, qty: 0, rows: 0 };
    cur.qty += (r.qty === null ? 1 : r.qty); cur.rows += 1;
    agg.set(key, cur);
  });
  const preview = [];
  let totalMatched = 0, totalUnmatched = 0, totalNewQty = 0;
  agg.forEach(entry => {
    let target = null;
    if (matchBy === 'barcode') target = byBarcode.get(entry.key);
    else { const arr = bySku.get(entry.key); if (arr && arr.length === 1) target = arr[0]; else if (arr && arr.length > 1) target = '__AMBIGUOUS__'; }
    if (target === '__AMBIGUOUS__') { preview.push({ entry, target: null, action: 'ambiguous' }); totalUnmatched++; }
    else if (!target) { preview.push({ entry, target: null, action: 'not_in_master' }); totalUnmatched++; }
    else {
      const newQty = mode === 'add' ? (target.qtyCounted || 0) + entry.qty : entry.qty;
      preview.push({ entry, target, action: 'update', newQty });
      totalMatched++; totalNewQty += newQty;
    }
  });
  batchMatchPreview = preview;
  const wrap = $('#batchPreviewBox');
  const showRows = preview.slice(0, 50);
  let html = '<div style="font-size:13px;font-weight:600;margin-bottom:6px">Preview (สูงสุด 50) — รวม ' + preview.length + ' รายการ</div>';
  html += '<div class="batch-preview-wrap"><table class="batch-preview"><thead><tr><th>Key</th><th>Title</th><th>เดิม</th><th>Upload</th><th>ใหม่</th><th>Action</th></tr></thead><tbody>';
  showRows.forEach(p => {
    const cls = p.action === 'update' ? 'match-ok' : 'match-fail';
    const title = p.target ? p.target.title : (p.action === 'ambiguous' ? '⚠️ SKU ซ้ำ' : '❓ ไม่พบ');
    const oldQ = p.target ? (p.target.qtyCounted || 0) : '-';
    const newQ = p.target ? p.newQty : '-';
    const actLabel = p.action === 'update' ? '✓ Update' : (p.action === 'ambiguous' ? '⚠ Skip' : '+ Orphan');
    html += '<tr class="' + cls + '"><td>' + escapeHtml(p.entry.key) + '</td><td>' + escapeHtml(title) + '</td><td>' + oldQ + '</td><td>' + p.entry.qty + '</td><td><b>' + newQ + '</b></td><td>' + actLabel + '</td></tr>';
  });
  html += '</tbody></table></div>';
  wrap.innerHTML = html;
  $('#batchSummaryBox').innerHTML = '📊 จับคู่ได้: <b>' + totalMatched + '</b> · ไม่พบ: <b>' + totalUnmatched + '</b> · ยอดใหม่รวม: <b>' + totalNewQty + '</b>';
  $('#batchApplyBtn').disabled = totalMatched === 0 && totalUnmatched === 0;
}
async function applyBatchImport() {
  if (!batchMatchPreview) return;
  const btn = $('#batchApplyBtn');
  btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
  let updated = 0, orphans = 0, skipped = 0;
  try {
    for (const p of batchMatchPreview) {
      if (p.action === 'update' && p.target) {
        await db.items.update(p.target.id, { qtyCounted: p.newQty });
        const idx = state.currentItems.findIndex(i => String(i.id) === String(p.target.id));
        if (idx >= 0) state.currentItems[idx].qtyCounted = p.newQty;
        updated++;
      } else if (p.action === 'not_in_master') {
        const item = {
          sessionId: state.currentSessionId,
          barcode: p.entry.barcode || '', sku: p.entry.sku || '',
          title: '⚠️ จาก Batch Upload', type: '', size: '', color: '', vendor: '', price: 0, cost: 0,
          qtyInitial: 0, qtyCounted: p.entry.qty, _notInMaster: true,
        };
        const id = await db.items.add(item);
        state.currentItems.push({ ...item, id });
        orphans++;
      } else skipped++;
    }
    touchSession();
    toast('✅ Import สำเร็จ: อัปเดต ' + updated + ' · Orphan ' + orphans + (skipped ? ' · Skip ' + skipped : ''), 'success');
    closeBatchImport();
    populateAttrFilters();
    renderTable(); renderStats();
  } catch (e) { console.error(e); toast('Import ผิดพลาด: ' + (e.message || e), 'error'); }
  finally { btn.disabled = false; btn.textContent = '✓ บันทึก'; }
}


// ============ MERGE TOOL (combine multiple Excel exports) ============
const mergeState = {
  files: [],          // [{ name, rows, ts }]
  merged: new Map(),  // key → { barcode, sku, title, type, size, color, vendor, qtyInitialMax, qtyInitialAll: Set, qtyCountedSum, fileCount, status }
  filter: { search: '', status: 'all' },
};

function resetMergeView() {
  mergeState.files = [];
  mergeState.merged.clear();
  $('#mergeUploadStep').style.display = 'block';
  $('#mergePreviewStep').style.display = 'none';
  $('#mergeFileInput').value = '';
  renderMergeFilesList();
  $('#mergeProcessBtn').disabled = true;
}

function renderMergeFilesList() {
  const box = $('#mergeFilesList');
  if (mergeState.files.length === 0) {
    box.innerHTML = '<div class="text-muted" style="font-size:13px;margin-top:8px">ยังไม่มีไฟล์ — Upload อย่างน้อย 1 ไฟล์เพื่อเริ่ม</div>';
    return;
  }
  let html = '<div style="margin-top:8px">';
  mergeState.files.forEach((f, idx) => {
    html += '<div class="chip" style="margin:3px 4px 3px 0"><span>📄 ' + escapeHtml(f.name) + ' (' + f.rows.length + ' rows)</span>';
    html += ' <button onclick="removeMergeFile(' + idx + ')" title="ลบ">×</button></div>';
  });
  html += '</div>';
  box.innerHTML = html;
}

window.removeMergeFile = (idx) => {
  mergeState.files.splice(idx, 1);
  renderMergeFilesList();
  $('#mergeProcessBtn').disabled = mergeState.files.length === 0;
};

async function addMergeFile(file) {
  try {
    const result = await parseExcelFile(file);
    // Find first sheet that looks like Stock Count export (has Barcode/SKU + Qty Counted)
    // For simplicity, use the sheet returned by parseExcelFile (Products or first)
    let rows = result.rows;
    // If sheet has only Summary-like data, skip
    if (rows.length < 2 && file.name) {
      // Try other sheets
    }
    const cleaned = rows.map(r => {
      const keys = {}; Object.keys(r).forEach(k => keys[k.toLowerCase().trim()] = k);
      const pick = (...names) => { for (const n of names) { if (keys[n.toLowerCase()] !== undefined) { const v = r[keys[n.toLowerCase()]]; if (v !== '' && v !== null && v !== undefined) return v; } } return ''; };
      const num = (v) => { if (v === '' || v === null || v === undefined) return 0; const n = Number(String(v).replace(/,/g, '')); return isNaN(n) ? 0 : n; };
      return {
        barcode: normalizeBarcode(pick('Barcode', 'Variant Barcode')),
        sku: String(pick('SKU', 'Variant SKU') || '').trim(),
        title: String(pick('Title', 'Name', 'ชื่อสินค้า') || '').trim(),
        type: String(pick('Type') || '').trim(),
        size: String(pick('Size', 'Option1 Value') || '').trim(),
        color: String(pick('Color', 'Option2 Value') || '').trim(),
        vendor: String(pick('Vendor', 'Brand') || '').trim(),
        qtyInitial: num(pick('Qty Initial', 'Qty', 'Variant Inventory Qty')),
        qtyCounted: num(pick('Qty Counted', 'นับได้', 'Counted', 'QT')),
      };
    }).filter(r => r.barcode || r.sku);
    if (cleaned.length === 0) { toast('ไม่พบข้อมูลใน ' + file.name, 'warning'); return; }
    mergeState.files.push({ name: file.name, rows: cleaned, ts: Date.now() });
    toast('เพิ่ม ' + file.name + ' — ' + cleaned.length + ' rows', 'success');
    renderMergeFilesList();
    $('#mergeProcessBtn').disabled = mergeState.files.length === 0;
  } catch (e) {
    console.error(e);
    toast('อ่านไฟล์ไม่สำเร็จ: ' + (e.message || e), 'error');
  }
}

function processMerge() {
  const matchBy = $('#mergeMatchSelect').value || 'barcode';
  const conflictPolicy = $('#mergeConflictSelect').value || 'max';
  const map = new Map();
  mergeState.files.forEach((f, fileIdx) => {
    f.rows.forEach(r => {
      let key;
      if (matchBy === 'barcode') key = r.barcode || ('__SKU__' + r.sku + '__' + r.size);
      else key = r.sku + '_' + r.size;
      if (!key || key === '_') return;
      const entry = map.get(key) || {
        barcode: r.barcode, sku: r.sku, title: r.title, type: r.type, size: r.size, color: r.color, vendor: r.vendor,
        qtyInitialAll: [], qtyCountedSum: 0, files: new Set(), titles: new Set(),
      };
      // Merge metadata — prefer non-empty
      if (!entry.barcode && r.barcode) entry.barcode = r.barcode;
      if (!entry.title && r.title) entry.title = r.title;
      if (!entry.type && r.type) entry.type = r.type;
      if (!entry.size && r.size) entry.size = r.size;
      if (!entry.color && r.color) entry.color = r.color;
      if (!entry.vendor && r.vendor) entry.vendor = r.vendor;
      if (r.title) entry.titles.add(r.title);
      entry.qtyInitialAll.push(r.qtyInitial);
      entry.qtyCountedSum += r.qtyCounted;
      entry.files.add(f.name);
      map.set(key, entry);
    });
  });
  // Resolve qty_initial based on conflict policy
  map.forEach(e => {
    const uniq = Array.from(new Set(e.qtyInitialAll));
    e.conflict = uniq.length > 1;
    if (conflictPolicy === 'max') e.qtyInitial = Math.max.apply(null, e.qtyInitialAll);
    else if (conflictPolicy === 'first') e.qtyInitial = e.qtyInitialAll[0];
    else e.qtyInitial = e.qtyInitialAll[e.qtyInitialAll.length - 1];
    e.diff = e.qtyCountedSum - e.qtyInitial;
    if (e.qtyInitial === 0 && e.qtyCountedSum === 0) e.status = 'ZERO';
    else if (e.qtyCountedSum === e.qtyInitial) e.status = 'MATCHED';
    else if (e.qtyCountedSum > e.qtyInitial) e.status = 'OVER';
    else if (e.qtyCountedSum === 0) e.status = 'NOT_STARTED';
    else e.status = 'UNDER';
  });
  mergeState.merged = map;
  $('#mergeUploadStep').style.display = 'none';
  $('#mergePreviewStep').style.display = 'block';
  renderMergeTable();
  renderMergeSummary();
}

function filterMergeRows() {
  const search = mergeState.filter.search.toLowerCase().trim();
  const status = mergeState.filter.status;
  return Array.from(mergeState.merged.values()).filter(e => {
    if (search) {
      const hay = (e.barcode + ' ' + e.sku + ' ' + e.title + ' ' + e.size + ' ' + e.vendor).toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (status === 'conflict' && !e.conflict) return false;
    if (status === 'matched' && e.status !== 'MATCHED') return false;
    if (status === 'under' && e.status !== 'UNDER') return false;
    if (status === 'over' && e.status !== 'OVER') return false;
    return true;
  });
}

function renderMergeTable() {
  const rows = filterMergeRows();
  const tbody = $('#mergeTableBody');
  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted" style="padding:30px">ไม่มีรายการ</td></tr>';
    return;
  }
  // Limit display to first 500 rows for performance
  const display = rows.slice(0, 500);
  tbody.innerHTML = display.map(e => {
    let cls = '';
    if (e.status === 'MATCHED') cls = 'matched';
    else if (e.status === 'OVER') cls = 'over';
    const diffColor = e.diff === 0 ? 'var(--success)' : e.diff > 0 ? 'var(--danger)' : 'var(--warning)';
    const conflictBadge = e.conflict ? ' <span style="color:var(--warning);font-size:11px">⚠️ Conflict</span>' : '';
    return '<tr class="' + cls + '">' +
      '<td><code>' + escapeHtml(e.barcode) + '</code></td>' +
      '<td>' + escapeHtml(e.sku) + '</td>' +
      '<td class="title">' + escapeHtml(e.title) + '</td>' +
      '<td>' + escapeHtml(e.size) + '</td>' +
      '<td class="num">' + fmtNum(e.qtyInitial) + conflictBadge + '</td>' +
      '<td class="num"><b>' + fmtNum(e.qtyCountedSum) + '</b></td>' +
      '<td class="num" style="color:' + diffColor + '">' + (e.diff > 0 ? '+' : '') + fmtNum(e.diff) + '</td>' +
      '<td><span class="chip" style="font-size:11px">' + e.files.size + ' ไฟล์</span></td>' +
      '<td>' + e.status + '</td>' +
      '</tr>';
  }).join('');
  if (rows.length > 500) {
    tbody.innerHTML += '<tr><td colspan="9" class="text-center text-muted" style="padding:12px">(แสดง 500 จาก ' + rows.length + ' รายการ — ใช้ Search เพื่อกรอง)</td></tr>';
  }
}

function renderMergeSummary() {
  const all = Array.from(mergeState.merged.values());
  const total = all.length;
  const matched = all.filter(e => e.status === 'MATCHED').length;
  const under = all.filter(e => e.status === 'UNDER').length;
  const over = all.filter(e => e.status === 'OVER').length;
  const conflict = all.filter(e => e.conflict).length;
  const totalInit = all.reduce((s, e) => s + e.qtyInitial, 0);
  const totalCount = all.reduce((s, e) => s + e.qtyCountedSum, 0);
  $('#mergeSummary').innerHTML =
    '📊 รวม <b>' + mergeState.files.length + '</b> ไฟล์ → <b>' + total + '</b> รายการ ' +
    '· ✅ ครบ <b>' + matched + '</b> · นับขาด <b>' + under + '</b> · นับเกิน <b>' + over + '</b> ' +
    '· ⚠️ Conflict <b>' + conflict + '</b><br>' +
    'ยอดรวม: นับได้ <b>' + fmtNum(totalCount) + '</b> / ตั้งต้น <b>' + fmtNum(totalInit) + '</b> (ส่วนต่าง ' + (totalCount - totalInit) + ')';
}

async function exportMerged() {
  if (mergeState.merged.size === 0) { toast('ยังไม่มีข้อมูล', 'warning'); return; }
  const all = Array.from(mergeState.merged.values());
  // Sheet 1: Merged Stock Count
  const detail = all.map(e => ({
    'Barcode': e.barcode, 'SKU': e.sku, 'Title': e.title, 'Type': e.type, 'Size': e.size, 'Color': e.color,
    'Vendor': e.vendor,
    'Qty Initial': e.qtyInitial, 'Qty Counted': e.qtyCountedSum, 'Difference': e.diff,
    'Status': e.status, 'Conflict': e.conflict ? 'YES' : '', 'Files': Array.from(e.files).join(' | '),
  }));
  // Sheet 2: Conflict report
  const conflicts = all.filter(e => e.conflict).map(e => ({
    'Barcode': e.barcode, 'SKU': e.sku, 'Title': e.title, 'Size': e.size,
    'Qty Initial (all values)': e.qtyInitialAll.join(', '),
    'Qty Initial (resolved)': e.qtyInitial, 'Qty Counted Sum': e.qtyCountedSum,
    'Files': Array.from(e.files).join(' | '),
  }));
  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(detail);
  ws1['!cols'] = [{wch:16},{wch:14},{wch:40},{wch:12},{wch:14},{wch:14},{wch:14},{wch:11},{wch:12},{wch:11},{wch:14},{wch:10},{wch:40}];
  lockBarcodeColumnAsText(ws1, 'Barcode');
  XLSX.utils.book_append_sheet(wb, ws1, 'Merged Result');
  if (conflicts.length > 0) {
    const ws2 = XLSX.utils.json_to_sheet(conflicts);
    ws2['!cols'] = [{wch:16},{wch:14},{wch:40},{wch:14},{wch:24},{wch:14},{wch:14},{wch:40}];
    lockBarcodeColumnAsText(ws2, 'Barcode');
    XLSX.utils.book_append_sheet(wb, ws2, 'Conflicts');
  }
  const filename = 'Merged_StockCount_' + todayStr() + '.xlsx';
  XLSX.writeFile(wb, filename);
  toast('Export สำเร็จ: ' + filename + ' (' + all.length + ' รายการ, ' + conflicts.length + ' conflicts)', 'success');
}

function wireMergeEvents() {
  $('#mergeDropZone').addEventListener('click', () => $('#mergeFileInput').click());
  $('#mergeFileInput').addEventListener('change', async (e) => {
    for (const f of e.target.files) await addMergeFile(f);
    $('#mergeFileInput').value = '';
  });
  $('#mergeDropZone').addEventListener('dragover', (e) => { e.preventDefault(); $('#mergeDropZone').classList.add('drag-over'); });
  $('#mergeDropZone').addEventListener('dragleave', () => $('#mergeDropZone').classList.remove('drag-over'));
  $('#mergeDropZone').addEventListener('drop', async (e) => {
    e.preventDefault(); $('#mergeDropZone').classList.remove('drag-over');
    for (const f of e.dataTransfer.files) await addMergeFile(f);
  });
  $('#mergeProcessBtn').onclick = processMerge;
  $('#mergeBackBtn').onclick = () => { $('#mergeUploadStep').style.display = 'block'; $('#mergePreviewStep').style.display = 'none'; };
  $('#mergeClearBtn').onclick = resetMergeView;
  $('#mergeExportBtn').onclick = exportMerged;
  $('#mergeMatchSelect').addEventListener('change', processMerge);
  $('#mergeConflictSelect').addEventListener('change', processMerge);
  $('#mergeSearchInput').addEventListener('input', (e) => { mergeState.filter.search = e.target.value; renderMergeTable(); });
  $('#mergeFilterStatus').addEventListener('change', (e) => { mergeState.filter.status = e.target.value; renderMergeTable(); });
}

// ============ Event Wiring ============
$('#navHomeBtn').onclick = () => { loadSessionList(); showView('Home'); };
$('#navNewBtn').onclick = () => openNewSessionView();
$('#newSessionBtnHome').onclick = () => openNewSessionView();
$('#navReceiveBtn').onclick = showReceiveView;
$('#navMergeBtn').onclick = () => { resetMergeView(); showView('Merge'); };
$('#navSettingsBtn').onclick = async () => { await renderWarehouseChips(); showStorageInfo(); showView('Settings'); };
$('#cancelNewBtn').onclick = () => { showView('Home'); loadSessionList(); };
$('#deleteSessionBtn').onclick = deleteCurrentSession;
$('#resetCountBtn').onclick = resetCounts;
$('#exportBtn').onclick = exportSession;
$('#clearAllBtn').onclick = clearAllData;

$('#searchInput').addEventListener('input', (e) => { state.filter.search = e.target.value; state.page = 1; renderTable(); });
$('#filterStatus').addEventListener('change', (e) => { state.filter.status = e.target.value; state.page = 1; renderTable(); });
$('#filterType').addEventListener('change', (e) => { state.filter.type = e.target.value; state.page = 1; renderTable(); });
$('#filterSize').addEventListener('change', (e) => { state.filter.size = e.target.value; state.page = 1; renderTable(); });
$('#filterColor').addEventListener('change', (e) => { state.filter.color = e.target.value; state.page = 1; renderTable(); });
$('#clearFiltersBtn').addEventListener('click', () => {
  state.filter = { search: '', status: 'all', type: '', size: '', color: '' };
  $('#searchInput').value = ''; $('#filterStatus').value = 'all';
  $('#filterType').value = ''; $('#filterSize').value = ''; $('#filterColor').value = '';
  state.page = 1; renderTable();
});

async function openNewSessionView() {
  parsedRows = null;
  $('#newSessionName').value = '';
  $('#newSessionDate').value = todayStr();
  $('#filePreview').style.display = 'none';
  $('#createSessionBtn').disabled = true;
  $('#fileInput').value = '';
  await refreshWarehouseSelect();
  showView('New');
}

$('#dropZone').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleFileSelected(e.target.files[0]); });
$('#dropZone').addEventListener('dragover', (e) => { e.preventDefault(); $('#dropZone').classList.add('drag-over'); });
$('#dropZone').addEventListener('dragleave', () => $('#dropZone').classList.remove('drag-over'));
$('#dropZone').addEventListener('drop', (e) => {
  e.preventDefault(); $('#dropZone').classList.remove('drag-over');
  if (e.dataTransfer.files[0]) handleFileSelected(e.dataTransfer.files[0]);
});

$('#createSessionBtn').onclick = async () => {
  if (!parsedRows) { toast('กรุณาเลือกไฟล์ Excel', 'error'); return; }
  const name = $('#newSessionName').value.trim() || ('Stock Count ' + todayStr());
  const org = $('#newSessionOrg').value;
  const warehouse = $('#newSessionWarehouse').value;
  const date = $('#newSessionDate').value || todayStr();
  if (!warehouse) { toast('กรุณาเลือกคลัง', 'error'); return; }
  const btn = $('#createSessionBtn'); btn.disabled = true; btn.textContent = 'กำลังบันทึก...';
  try {
    const id = await createSession({ name, org, warehouse, date });
    toast('สร้าง Session สำเร็จ', 'success');
    openSession(id);
  } catch (e) { console.error(e); toast('เกิดข้อผิดพลาด: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = 'เริ่มนับ'; }
};

$('#addWarehouseBtn').onclick = async () => {
  const name = await inputModal('เพิ่มคลังใหม่', 'ระบุชื่อคลัง:', '', 'เช่น Shop, Co-Sign, Flood');
  if (!name) return;
  try { await addWarehouse(name); await refreshWarehouseSelect(); $('#newSessionWarehouse').value = name.trim(); toast('เพิ่มคลังสำเร็จ', 'success'); }
  catch (e) { toast(e.message, 'error'); }
};
$('#saveWarehouseBtn').onclick = async () => {
  const name = $('#newWarehouseName').value.trim();
  if (!name) { toast('กรุณาใส่ชื่อคลัง', 'error'); return; }
  try { await addWarehouse(name); $('#newWarehouseName').value = ''; await renderWarehouseChips(); toast('เพิ่มคลังสำเร็จ', 'success'); }
  catch (e) { toast(e.message, 'error'); }
};

// Edit Item events
$('#editItemCancelBtn').onclick = closeEditItemModal;
$('#editItemSaveBtn').onclick = saveEditItem;
$('#editItemBarcode').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#editItemQtyInitial').focus(); } });
$('#editItemQtyInitial').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveEditItem(); } });
$('#editItemModal').addEventListener('click', (e) => { if (e.target.id === 'editItemModal') closeEditItemModal(); });

// Batch import events
$('#batchImportBtn').onclick = openBatchImport;
$('#batchCancelBtn').onclick = closeBatchImport;
$('#batchBackBtn').onclick = () => {
  $('#batchStep1').style.display = 'block';
  $('#batchStep2').style.display = 'none';
  $('#batchBackBtn').style.display = 'none';
  $('#batchApplyBtn').style.display = 'none';
};
$('#batchApplyBtn').onclick = applyBatchImport;
$('#batchDropZone').addEventListener('click', () => $('#batchFileInput').click());
$('#batchFileInput').addEventListener('change', (e) => { if (e.target.files[0]) handleBatchFile(e.target.files[0]); });
$('#batchDropZone').addEventListener('dragover', (e) => { e.preventDefault(); $('#batchDropZone').classList.add('drag-over'); });
$('#batchDropZone').addEventListener('dragleave', () => $('#batchDropZone').classList.remove('drag-over'));
$('#batchDropZone').addEventListener('drop', (e) => { e.preventDefault(); $('#batchDropZone').classList.remove('drag-over'); if (e.dataTransfer.files[0]) handleBatchFile(e.dataTransfer.files[0]); });
$('#batchModeSelect').addEventListener('change', refreshBatchPreview);
$('#batchMatchSelect').addEventListener('change', refreshBatchPreview);

// Camera events
$('#openCameraBtn').onclick = () => openCameraScanner();
$('#closeCameraBtn').onclick = closeCameraScanner;
$('#switchCameraBtn').onclick = switchCamera;
$('#cameraOverlay').addEventListener('click', (e) => { if (e.target.id === 'cameraOverlay') closeCameraScanner(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#cameraOverlay').classList.contains('active')) closeCameraScanner(); });

// Scanner input
const barcodeInput = $('#barcodeInput');
barcodeInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    const code = barcodeInput.value;
    if (code.trim()) handleScan(code);
    barcodeInput.value = '';
  }
});

function updateFocusIndicator() {
  const ind = $('#focusIndicator');
  if (!ind) return;
  if (document.activeElement === barcodeInput) { ind.textContent = '● พร้อมรับสแกน'; ind.classList.remove('lost'); }
  else { ind.textContent = '○ คลิกที่ช่อง Barcode'; ind.classList.add('lost'); }
}
document.addEventListener('focusin', updateFocusIndicator);
document.addEventListener('focusout', updateFocusIndicator);

// Service Worker
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => console.warn('SW failed:', err));
  });
} else if (location.protocol === 'file:') {
  console.info('[Stock Count v2.0] Pure Local mode via file:// — SW disabled, camera disabled, USB scanner only');
}

function updateProtocolNote() {
  const el = $('#protocolNote'); if (!el) return;
  if (location.protocol === 'file:') {
    el.innerHTML = '⚠️ <b>file:// mode:</b> ใช้ USB scanner เท่านั้น (กล้อง + SW disabled โดย browser security)';
    el.style.color = 'var(--warning)';
  } else {
    el.innerHTML = '✅ Protocol: <code>' + location.protocol + '</code> — full features available';
    el.style.color = 'var(--success)';
  }
}

// Init
(async function init() {
  try {
    await ensureDefaultWarehouses();
    await refreshWarehouseSelect();
    await loadSessionList();
    updateProtocolNote();
    wireReceiveEvents();
    wireMergeEvents();
    showView('Home');
  } catch (e) {
    console.error('Init failed:', e);
    toast('Init failed: ' + (e.message || e), 'error');
  }
})();
