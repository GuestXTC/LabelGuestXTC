/* =========================================================================
 * LabelGuestXTC — renderer + editor
 * Fully self-contained, MIT licensed. Barcode/QR/PDF handled by open-source
 * libraries loaded from node_modules (bundled offline in the distributed app).
 * ========================================================================= */
const JsBarcode = require('jsbarcode');
const QRCode   = require('qrcode');
const XLSX     = require('xlsx');
const { jsPDF } = require('jspdf');

const SCREEN_DPI = 96;
const MM = 25.4;
const pxPerMmBase = SCREEN_DPI / MM;

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const api = window.labelApi;

/* ---------------- state ---------------- */
let doc = makeDoc();
let selectedId = null;
let selectedIds = [];         // multi-selection (includes selectedId as primary)
let zoom = 1;
let showGuides = true;
let showGrid = false;
let gridSize = 5;             // mm
let history = [];
let hi = -1;
let batchRows = [];
let batchHeaders = [];
let guides = [];
let clipboard = [];           // copied elements
let imageCache = {};          // src -> HTMLImageElement

function makeDoc() {
  return {
    name: '未命名标签',
    width: 100,
    height: 60,
    dpi: 203,
    elements: []
  };
}

function uid() { return 'el_' + Math.random().toString(36).slice(2, 9); }

function defaultElement(type) {
  const base = { id: uid(), type, name: typeName(type), x: 8, y: 8, w: 40, h: 16, rotation: 0, field: '', locked: false, hidden: false };
  switch (type) {
    case 'text':    return Object.assign(base, { text: '双击编辑文本', fontFamily: 'Microsoft YaHei', fontSize: 5, bold: false, italic: false, underline: false, strike: false, inverse: false, letterSpacing: 0, lineSpacing: 1.15, color: '#111111', align: 'left' });
    case 'barcode': return Object.assign(base, { w: 60, h: 20, value: '123456789012', format: 'CODE128', displayValue: true, lineColor: '#111111', textPosition: 'bottom', moduleWidth: 2, textGap: 0 });
    case 'qrcode':  return Object.assign(base, { w: 25, h: 25, value: 'https://example.com', ec: 'M', symbolVersion: 'auto', charset: 'ANSI', textPosition: 'none' });
    case 'image':   return Object.assign(base, { w: 30, h: 30, src: '', grayscale: false, opacity: 1 });
    case 'rect':    return Object.assign(base, { w: 40, h: 24, fill: '#ffffff', stroke: '#111111', strokeWidth: 0.4, radius: 0 });
    case 'ellipse': return Object.assign(base, { w: 30, h: 30, fill: '#ffffff', stroke: '#111111', strokeWidth: 0.4 });
    case 'triangle':return Object.assign(base, { w: 30, h: 26, fill: '#ffffff', stroke: '#111111', strokeWidth: 0.4 });
    case 'line':    return Object.assign(base, { w: 40, h: 0, stroke: '#111111', strokeWidth: 0.4 });
    case 'blackout':return Object.assign(base, { w: 30, h: 20, fill: '#000000', radius: 0 });
    case 'table':   return Object.assign(base, { w: 60, h: 24, rows: 3, cols: 3, colRatios: [1,1,1], rowRatios: [1,1,1], borderWidth: 0.3, borderColor: '#111111', merges: [], cells: {}, cellFontSize: 3, cellFontFamily: 'Microsoft YaHei', cellColor: '#111111' });
    case 'date':    return Object.assign(base, { type: 'text', name: '日期时间', dynamic: 'date', text: 'YYYY-MM-DD', w: 40, h: 10, fontFamily: 'Microsoft YaHei', fontSize: 5, color: '#111111', align: 'left', dateFormat: 'YYYY-MM-DD', dateUnit: 'day', dateStep: 0 });
    default:        return base;
  }
}

function typeName(t) {
  return ({ text: '文本', barcode: '一维码', qrcode: '二维码', image: '图片', rect: '矩形', ellipse: '椭圆', triangle: '三角形', line: '线条', table: '表格', blackout: '区域反黑' })[t] || t;
}

function typeIcon(t) {
  return ({ text: 'T', barcode: '▥', qrcode: '▦', image: '▣', rect: '▭', ellipse: '◯', triangle: '△', line: '╱', table: '▤' })[t] || '•';
}

function getSelected() { return doc.elements.find(e => e.id === selectedId) || null; }
function getSelectedElements() {
  const ids = selectedIds.length ? selectedIds : (selectedId ? [selectedId] : []);
  return ids.map(id => doc.elements.find(e => e.id === id)).filter(Boolean);
}
function selectOnly(id) { selectedId = id; selectedIds = id ? [id] : []; }
function toggleSelect(id) {
  if (!id) return;
  const i = selectedIds.indexOf(id);
  if (i >= 0) {
    selectedIds.splice(i, 1);
    if (selectedId === id) selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
  } else {
    selectedIds.push(id); selectedId = id;
  }
}
function isSelected(id) { return selectedIds.includes(id) || (!selectedIds.length && selectedId === id); }

/* ---------------- history ---------------- */
function snapshot() { return JSON.stringify(doc); }
function commit() {
  const s = snapshot();
  if (hi >= 0 && history[hi] === s) return;
  history = history.slice(0, hi + 1);
  history.push(s);
  if (history.length > 80) history.shift();
  hi = history.length - 1;
}
function restore() {
  doc = JSON.parse(history[hi]);
  if (!doc.elements.some(e => e.id === selectedId)) selectedId = null;
  // Keep the active tab's doc reference in sync after undo/redo.
  const t = tabs && tabs.find(x => x.id === activeTabId);
  if (t) { t.doc = doc; t.history = history; t.hi = hi; }
  refreshAll();
}
function undo() { if (hi > 0) { hi--; restore(); } }
function redo() { if (hi < history.length - 1) { hi++; restore(); } }

/* ---------------- canvas sizing & render ---------------- */
const canvas = $('#labelCanvas');
const ctx = canvas.getContext('2d');

// Editor-only margin around the label. Overflowing elements are drawn here in
// semi-transparent form so they stay visible/editable, but are never printed.
const EDITOR_PAD_MM = 12;

function scaleFactor() { return pxPerMmBase * zoom; }

function resizeCanvas() {
  const s = scaleFactor();
  const pad = Math.round(EDITOR_PAD_MM * s);
  canvas.width = Math.round(doc.width * s) + pad * 2;
  canvas.height = Math.round(doc.height * s) + pad * 2;
  canvas.style.width = canvas.width + 'px';
  canvas.style.height = canvas.height + 'px';
  $('#canvasWrap').style.width = canvas.width + 'px';
  $('#canvasWrap').style.height = canvas.height + 'px';
}

function mmRect(el) { return { x: el.x, y: el.y, w: el.w, h: el.h }; }

function render(ctx2, targetDoc, scale, opts = {}) {
  const { forExport = false, record = null, batchEnabled = false } = opts;
  const padPx = forExport ? 0 : Math.round(EDITOR_PAD_MM * scale);
  ctx2.save();
  ctx2.setTransform(1, 0, 0, 1, 0, 0);
  ctx2.clearRect(0, 0, ctx2.canvas.width, ctx2.canvas.height);
  ctx2.translate(padPx, padPx); // editor: shift so label origin starts after margin
  ctx2.scale(scale, scale); // now drawing units == mm

  if (forExport) {
    // Print/export: exact label bitmap, clipped to page bounds.
    ctx2.fillStyle = targetDoc.background || '#ffffff';
    ctx2.fillRect(0, 0, targetDoc.width, targetDoc.height);
    ctx2.beginPath();
    ctx2.rect(0, 0, targetDoc.width, targetDoc.height);
    ctx2.clip();
  } else {
    // Editor: draw a soft "outside the page" backdrop, then the white page.
    ctx2.fillStyle = '#eef1f6';
    ctx2.fillRect(-EDITOR_PAD_MM, -EDITOR_PAD_MM,
      targetDoc.width + EDITOR_PAD_MM * 2, targetDoc.height + EDITOR_PAD_MM * 2);
    ctx2.fillStyle = targetDoc.background || '#ffffff';
    ctx2.fillRect(0, 0, targetDoc.width, targetDoc.height);
  }

  if (!forExport && showGrid && gridSize > 0) {
    ctx2.strokeStyle = '#d9e2ee'; ctx2.lineWidth = 0.15;
    ctx2.beginPath();
    for (let x = 0; x <= targetDoc.width; x += gridSize) { ctx2.moveTo(x, 0); ctx2.lineTo(x, targetDoc.height); }
    for (let y = 0; y <= targetDoc.height; y += gridSize) { ctx2.moveTo(0, y); ctx2.lineTo(targetDoc.width, y); }
    ctx2.stroke();
  }
  for (const el of targetDoc.elements) {
    if (el.hidden) continue; // hidden elements are not drawn or exported
    if (!forExport && elementOverflows(el, targetDoc)) {
      // Overflowing elements: draw inside page normally, and the overflowing
      // part semi-transparent so it is clearly "outside the printable area".
      ctx2.save();
      ctx2.beginPath();
      ctx2.rect(0, 0, targetDoc.width, targetDoc.height);
      ctx2.clip();
      drawElement(ctx2, el, scale, { forExport, record, batchEnabled });
      ctx2.restore();
      ctx2.save();
      ctx2.globalAlpha = 0.28;
      drawElement(ctx2, el, scale, { forExport, record, batchEnabled });
      ctx2.restore();
    } else {
      drawElement(ctx2, el, scale, { forExport, record, batchEnabled });
    }
  }
  if (!forExport && showGuides) drawGuides(ctx2, scale);
  ctx2.restore();
}
// True when an element sticks out beyond the label rectangle (axis-aligned bounds).
function elementOverflows(el, d) {
  const x1 = Math.min(el.x, el.x + el.w), x2 = Math.max(el.x, el.x + el.w);
  const y1 = Math.min(el.y, el.y + el.h), y2 = Math.max(el.y, el.y + el.h);
  return x1 < -0.05 || y1 < -0.05 || x2 > d.width + 0.05 || y2 > d.height + 0.05;
}

function resolvedValue(raw, record, batchEnabled, el) {
  if (!batchEnabled || !record) return raw == null ? '' : String(raw);
  // "绑定字段" (el.field): when set, the element is bound directly to that
  // column and shows its value, ignoring the static content. NiceLabel-style
  // database binding. Template {columns} still work as before.
  const bound = el && el.field && String(el.field).trim();
  if (bound) {
    if (bound === '序列号' || bound === '{序列号}') return record.__serial != null ? String(record.__serial) : '';
    if (bound === '日期' || bound === '{日期}') return record.__date != null ? String(record.__date) : '';
    const bk = bound.replace(/^\{|\}$/g, '').trim();
    if (Object.prototype.hasOwnProperty.call(record, bk)) return record[bk] == null ? '' : String(record[bk]);
  }
  let out = String(raw == null ? '' : raw);
  out = out.replace(/\{([^}]+)\}/g, (m, key) => {
    const k = key.trim();
    if (k === '序列号') return record.__serial;
    if (k === '日期') return record.__date;
    if (Object.prototype.hasOwnProperty.call(record, k)) return record[k];
    return m;
  });
  return out;
}

function drawElement(c, el, scale, opt) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  c.save();
  if (el.rotation) {
    c.translate(cx, cy);
    c.rotate(el.rotation * Math.PI / 180);
    c.translate(-cx, -cy);
  }
  switch (el.type) {
    case 'text':    drawText(c, el, opt); break;
    case 'barcode': drawBarcode(c, el, scale, opt); break;
    case 'qrcode':  drawQR(c, el, opt); break;
    case 'image':   drawImageEl(c, el); break;
    case 'rect':    drawRect(c, el); break;
    case 'blackout':drawBlackout(c, el); break;
    case 'ellipse': drawEllipse(c, el); break;
    case 'triangle':drawTriangle(c, el); break;
    case 'line':    drawLine(c, el); break;
    case 'table':   drawTable(c, el, opt); break;
  }
  c.restore();
}

// Table geometry: supports per-column / per-row sizes via ratio arrays.
function tableRatios(el, axis) {
  const key = axis === 'col' ? 'colRatios' : 'rowRatios';
  const n = axis === 'col' ? (el.cols || 1) : (el.rows || 1);
  let arr = el[key];
  if (!Array.isArray(arr) || arr.length !== n) arr = new Array(n).fill(1);
  return arr.slice();
}
function tableEdges(el) {
  const cols = Math.max(1, el.cols || 1), rows = Math.max(1, el.rows || 1);
  const cr = tableRatios(el, 'col'), rr = tableRatios(el, 'row');
  const cs = cr.reduce((a, b) => a + (b > 0 ? b : 0.01), 0) || 1;
  const rs = rr.reduce((a, b) => a + (b > 0 ? b : 0.01), 0) || 1;
  const xs = [el.x], ys = [el.y];
  for (let c = 0; c < cols; c++) xs.push(xs[c] + el.w * (cr[c] > 0 ? cr[c] : 0.01) / cs);
  for (let r = 0; r < rows; r++) ys.push(ys[r] + el.h * (rr[r] > 0 ? rr[r] : 0.01) / rs);
  xs[cols] = el.x + el.w; ys[rows] = el.y + el.h;
  return { xs, ys, cols, rows };
}

// ---- Merged cells -------------------------------------------------------
// A merge is { r, c, rs, cs }: top-left cell + span rows/cols. Normalize and
// drop degenerate merges so the renderer can trust the data.
function tableMerges(el) {
  if (!Array.isArray(el.merges)) return [];
  const cols = Math.max(1, el.cols || 1), rows = Math.max(1, el.rows || 1);
  return el.merges.filter(m => m && m.rs >= 1 && m.cs >= 1 &&
    m.r >= 0 && m.c >= 0 && m.r + m.rs <= rows && m.c + m.cs <= cols &&
    !(m.rs === 1 && m.cs === 1));
}
// Is the horizontal grid line at row boundary `r` (between row r-1 and r),
// over column c, hidden by a merge spanning vertically across it?
function hLineMerged(merges, r, c) {
  // line r is between row r-1 and r; skip if a merge covers both sides
  return merges.some(m => c >= m.c && c < m.c + m.cs && r > m.r && r < m.r + m.rs);
}
// Is the vertical grid line at col boundary `col`, over row r, hidden by a
// merge spanning horizontally across it?
function vLineMerged(merges, col, r) {
  return merges.some(m => r >= m.r && r < m.r + m.rs && col > m.c && col < m.c + m.cs);
}
// Which merge covers cell (r,c)? Returns the merge (whose top-left may differ).
function mergeAt(el, r, c) {
  return tableMerges(el).find(m => r >= m.r && r < m.r + m.rs && c >= m.c && c < m.c + m.cs) || null;
}
// Map a point (already in element-local coords) to { r, c } cell indices.
function pointToCell(el, p) {
  const { xs, ys, cols, rows } = tableEdges(el);
  if (p.x < el.x || p.x > el.x + el.w || p.y < el.y || p.y > el.y + el.h) return null;
  let c = cols - 1, r = rows - 1;
  for (let i = 0; i < cols; i++) if (p.x < xs[i+1]) { c = i; break; }
  for (let i = 0; i < rows; i++) if (p.y < ys[i+1]) { r = i; break; }
  return { r, c };
}
// Selection of grid cells during a drag on a table: { r0, c0, r1, c1 }.
let cellSel = null;
let cellMergeBar = null; // floating DOM bar element

// Draw-line mode: click the Line tool then drag on canvas to draw a line that
// snaps to horizontal / vertical. `linePreview` holds the live preview.
let drawMode = null;
let linePreview = null;

function cellSelRect() {
  if (!cellSel) return null;
  const el = doc.elements.find(e => e.id === cellSel.id);
  if (!el || el.type !== 'table') return null;
  const { xs, ys } = tableEdges(el);
  const rA = Math.min(cellSel.r0, cellSel.r1), rB = Math.max(cellSel.r0, cellSel.r1);
  const cA = Math.min(cellSel.c0, cellSel.c1), cB = Math.max(cellSel.c0, cellSel.c1);
  return { el, rA, rB, cA, cB, x0: xs[cA], y0: ys[rA], x1: xs[cB+1], y1: ys[rB+1] };
}
function hideCellMergeBar() {
  if (cellMergeBar) { cellMergeBar.remove(); cellMergeBar = null; }
}
function showCellMergeBar() {
  const rect = cellSelRect(); if (!rect) return;
  hideCellMergeBar();
  const s = scaleFactor();
  const bar = document.createElement('div');
  bar.className = 'cell-merge-bar';
  const rows = rect.rB - rect.rA + 1, cols = rect.cB - rect.cA + 1;
  const centerX = (rect.x0 + rect.x1) / 2 * s, topY = rect.y0 * s;
  bar.style.left = centerX + 'px';
  bar.style.top = Math.max(0, topY - 44) + 'px';
  bar.innerHTML = `<span>${rows}×${cols}</span>`;
  const mergeBtn = document.createElement('button');
  mergeBtn.textContent = '合并';
  mergeBtn.onclick = (e) => { e.stopPropagation(); doMergeCells(); };
  const splitBtn = document.createElement('button');
  splitBtn.textContent = '拆分';
  splitBtn.className = 'ghost';
  splitBtn.onclick = (e) => { e.stopPropagation(); doSplitCells(); };
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '✕'; cancelBtn.className = 'x';
  cancelBtn.onclick = (e) => { e.stopPropagation(); cellSel = null; hideCellMergeBar(); renderCanvas(); };
  bar.appendChild(mergeBtn); bar.appendChild(splitBtn); bar.appendChild(cancelBtn);
  const wrap = $('#canvasWrap'); if (!wrap) return;
  wrap.appendChild(bar); cellMergeBar = bar;
}
function doMergeCells() {
  const rect = cellSelRect(); if (!rect) return;
  const { el, rA, rB, cA, cB } = rect;
  el.merges = el.merges || [];
  el.merges.push({ r: rA, c: cA, rs: rB - rA + 1, cs: cB - cA + 1 });
  cellSel = null; hideCellMergeBar();
  commit(); refreshAll();
  toast('已合并 ' + (rB - rA + 1) + '×' + (cB - cA + 1) + ' 单元格');
}
function doSplitCells() {
  const rect = cellSelRect(); if (!rect) return;
  const { el, rA, rB, cA, cB } = rect;
  el.merges = (el.merges || []).filter(m => !(m.r >= rA && m.r + m.rs - 1 <= rB && m.c >= cA && m.c + m.cs - 1 <= cB));
  cellSel = null; hideCellMergeBar();
  commit(); refreshAll();
  toast('已拆分所选单元格');
}

// ---- Table context menu -------------------------------------------------
let ctxTable = null, ctxCell = null;
function hideTableCtx() { const m = $('#tableCtxMenu'); if (m) m.hidden = true; }
function showTableCtx(ev, table, cell) {
  const m = $('#tableCtxMenu'); if (!m) return;
  ctxTable = table; ctxCell = cell;
  m.hidden = false;
  const pad = 8;
  const x = Math.min(ev.clientX, window.innerWidth - m.offsetWidth - pad);
  const y = Math.min(ev.clientY, window.innerHeight - m.offsetHeight - pad);
  m.style.left = Math.max(pad, x) + 'px';
  m.style.top = Math.max(pad, y) + 'px';
}
function tableShiftCellText(el, axis, from, delta) {
  if (!el.cells) return;
  const next = {};
  for (const k of Object.keys(el.cells)) {
    let [r, c] = k.split(',').map(Number);
    if (axis === 'row' && r >= from) r += delta;
    if (axis === 'col' && c >= from) c += delta;
    next[r + ',' + c] = el.cells[k];
  }
  el.cells = next;
}
function tableCtxAction(act) {
  const el = ctxTable, cell = ctxCell;
  hideTableCtx();
  if (!el || el.locked) { toast('表格已锁定'); return; }
  const r = cell ? cell.r : 0, c = cell ? cell.c : 0;
  if (act === 'insertRowAbove' || act === 'insertRowBelow') {
    const at = act === 'insertRowAbove' ? r : r + 1;
    el.rows = (el.rows || 1) + 1;
    const rr = tableRatios(el, 'row'); rr.splice(at, 0, rr[Math.max(0, at - 1)] || 1); el.rowRatios = rr;
    tableShiftCellText(el, 'row', at, 1);
  } else if (act === 'insertColLeft' || act === 'insertColRight') {
    const at = act === 'insertColLeft' ? c : c + 1;
    el.cols = (el.cols || 1) + 1;
    const cr = tableRatios(el, 'col'); cr.splice(at, 0, cr[Math.max(0, at - 1)] || 1); el.colRatios = cr;
    tableShiftCellText(el, 'col', at, 1);
  } else if (act === 'deleteRow') {
    if ((el.rows || 1) <= 1) { toast('至少保留一行'); return; }
    el.rows = el.rows - 1;
    const rr = tableRatios(el, 'row'); rr.splice(r, 1); el.rowRatios = rr;
    if (!el.cells) el.cells = {};
    for (const k of Object.keys(el.cells)) { let [cr, cc] = k.split(',').map(Number); if (cr === r) delete el.cells[k]; else if (cr > r) { el.cells[(cr-1)+','+cc] = el.cells[k]; delete el.cells[k]; } }
    el.merges = tableMerges(el).filter(m => !(m.r <= r && r < m.r + m.rs)).map(m => m.r > r ? Object.assign({}, m, { r: m.r - 1 }) : m);
  } else if (act === 'deleteCol') {
    if ((el.cols || 1) <= 1) { toast('至少保留一列'); return; }
    el.cols = el.cols - 1;
    const cr = tableRatios(el, 'col'); cr.splice(c, 1); el.colRatios = cr;
    if (!el.cells) el.cells = {};
    for (const k of Object.keys(el.cells)) { let [cr, cc] = k.split(',').map(Number); if (cc === c) delete el.cells[k]; else if (cc > c) { el.cells[cr+','+(cc-1)] = el.cells[k]; delete el.cells[k]; } }
    el.merges = tableMerges(el).filter(m => !(m.c <= c && c < m.c + m.cs)).map(m => m.c > c ? Object.assign({}, m, { c: m.c - 1 }) : m);
  } else if (act === 'merge') {
    cellSel = { id: el.id, r0: r, c0: c, r1: r, c1: c };
    const mg = mergeAt(el, r, c);
    if (mg) { cellSel = { id: el.id, r0: mg.r, c0: mg.c, r1: mg.r + mg.rs - 1, c1: mg.c + mg.cs - 1 }; }
    doMergeCells();
  } else if (act === 'split') {
    const mg = mergeAt(el, r, c);
    if (mg) { cellSel = { id: el.id, r0: mg.r, c0: mg.c, r1: mg.r + mg.rs - 1, c1: mg.c + mg.cs - 1 }; doSplitCells(); }
    else toast('该单元格未合并');
  } else if (act === 'clearCell') {
    if (el.cells) { delete el.cells[r + ',' + c]; commit(); refreshAll(); }
  } else if (act === 'lockTable') {
    el.locked = !el.locked; commit(); refreshSelectionUI(); toast(el.locked ? '表格已锁定' : '表格已解锁');
  }
  renderCanvas();
}
function bindTableCtxMenu() {
  const m = $('#tableCtxMenu'); if (!m) return;
  m.querySelectorAll('button[data-act]').forEach(b => {
    b.onclick = (e) => { e.stopPropagation(); tableCtxAction(b.dataset.act); };
  });
  document.addEventListener('click', () => hideTableCtx());
  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const p = eventToMm(ev);
    for (let i = doc.elements.length - 1; i >= 0; i--) {
      const el = doc.elements[i];
      if (el.hidden || el.type !== 'table') continue;
      const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
      const a = -(el.rotation || 0) * Math.PI / 180;
      const ddx = p.x - cx, ddy = p.y - cy;
      const lp = { x: cx + ddx * Math.cos(a) - ddy * Math.sin(a), y: cy + ddx * Math.sin(a) + ddy * Math.cos(a) };
      const cell = pointToCell(el, lp);
      if (cell) { showTableCtx(ev, el, cell); return; }
    }
  });
}

// Table grid lines. Internal segments covered by a merged cell are omitted so
// a merged region renders as one big cell.
function drawTable(c, el, opt) {
  const { xs, ys, cols, rows } = tableEdges(el);
  const merges = tableMerges(el);
  c.strokeStyle = el.borderColor || '#111111';
  c.lineWidth = el.borderWidth || 0.3;
  c.beginPath();
  for (let r = 0; r <= rows; r++) {
    if (r === 0 || r === rows) { c.moveTo(el.x, ys[r]); c.lineTo(el.x + el.w, ys[r]); }
    else for (let col = 0; col < cols; col++) {
      if (!hLineMerged(merges, r, col)) { c.moveTo(xs[col], ys[r]); c.lineTo(xs[col+1], ys[r]); }
    }
  }
  for (let col = 0; col <= cols; col++) {
    if (col === 0 || col === cols) { c.moveTo(xs[col], el.y); c.lineTo(xs[col], el.y + el.h); }
    else for (let r = 0; r < rows; r++) {
      if (!vLineMerged(merges, col, r)) { c.moveTo(xs[col], ys[r]); c.lineTo(xs[col], ys[r+1]); }
    }
  }
  c.stroke();
  // Cell text content (stored as { "r,c": "text" }).
  const cells = el.cells || {};
  if (Object.keys(cells).length) {
    const fs = el.cellFontSize || 3;
    c.save();
    c.font = `400 ${fs}px "${el.cellFontFamily || 'Microsoft YaHei'}, sans-serif"`;
    c.textBaseline = 'middle'; c.textAlign = 'center';
    c.fillStyle = el.cellColor || '#111111';
    const merges = tableMerges(el);
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        const txt = cells[r + ',' + col];
        if (!txt) continue;
        // Skip cells swallowed by a merge (only the top-left renders).
        let swallowed = false;
        for (const mg of merges) {
          if (r >= mg.r && r < mg.r + mg.rs && col >= mg.c && col < mg.c + mg.cs && !(r === mg.r && col === mg.c)) { swallowed = true; break; }
        }
        if (swallowed) continue;
        const cx = (xs[col] + xs[col + 1]) / 2, cy = (ys[r] + ys[r + 1]) / 2;
        c.fillText(String(txt), cx, cy, xs[col + 1] - xs[col] - 1);
      }
    }
    c.restore();
  }
}

function fontPx(el) { return (el.fontSize || 5) * 1.0; } // in mm-units of ctx

// Dynamic date/time element: formats current date with day/month/year offset.
function computeDynamicDate(el) {
  const d = new Date();
  const unit = el.dateUnit || 'day', step = parseFloat(el.dateStep) || 0;
  if (unit === 'day') d.setDate(d.getDate() + step);
  else if (unit === 'month') d.setMonth(d.getMonth() + step);
  else if (unit === 'year') d.setFullYear(d.getFullYear() + step);
  else if (unit === 'hour') d.setHours(d.getHours() + step);
  const map = {
    YYYY: String(d.getFullYear()), MM: String(d.getMonth() + 1).padStart(2, '0'), DD: String(d.getDate()).padStart(2, '0'),
    HH: String(d.getHours()).padStart(2, '0'), mm: String(d.getMinutes()).padStart(2, '0'), SS: String(d.getSeconds()).padStart(2, '0'),
    YY: String(d.getFullYear()).slice(-2)
  };
  const fmt = el.dateFormat || 'YYYY-MM-DD';
  return String(fmt).replace(/YYYY|YY|MM|DD|HH|mm|SS/g, k => map[k] || k);
}

function drawText(c, el, opt) {
  let text = resolvedValue(el.text, opt.record, opt.batchEnabled, el);
  if (el.dynamic === 'date' || el.dynamic === 'time') text = computeDynamicDate(el);
  const size = fontPx(el);
  // Quote ONLY the family name; sans-serif must be a separate fallback token.
  // Wrapping "微软雅黑, sans-serif" in one pair of quotes makes an invalid
  // font shorthand that Chromium silently refuses to draw.
  const fam = String(el.fontFamily || 'Microsoft YaHei').split(',')[0].trim().replace(/^["']|["']$/g, '');
  c.font = `${el.italic ? 'italic ' : ''}${el.bold ? '700 ' : '400 '}${size}px "${fam}", sans-serif`;
  c.textBaseline = 'middle';
  // We always draw with textAlign='left' and position glyphs by hand. Using
  // canvas textAlign together with fillText's maxWidth makes Chromium compress
  // and re-anchor glyphs, which previously broke centering on file imports.
  c.textAlign = 'left';
  const align = ['center', 'right', 'justify', 'distribute'].indexOf(el.align) >= 0 ? el.align : 'left';
  const ls = el.letterSpacing || 0; // mm per char
  const color = el.color || '#111';
  const lines = String(text).split('\n');
  const lineH = size * (el.lineSpacing || 1.15);
  const totalH = (lines.length - 1) * lineH + size;
  const startY = el.y + (el.h - totalH) / 2 + size / 2;

  lines.forEach((ln, i) => {
    const y = startY + i * lineH;
    const chars = Array.from(ln);
    const widths = chars.map(ch => c.measureText(ch).width);
    const glyphW = widths.reduce((a, b) => a + b, 0);
    const naturalW = glyphW + ls * Math.max(0, chars.length - 1);

    // Spread modes stretch inter-character spacing so the line fills the box.
    // justify: all lines, with the last line stretched only when it is the sole
    // line (single-line labels are the common case); distribute: every line.
    const spread = (align === 'distribute') ||
      (align === 'justify' && (lines.length === 1 || i < lines.length - 1));
    let gap = ls;
    if (spread && chars.length > 1 && el.w > naturalW) {
      gap = (el.w - glyphW) / (chars.length - 1);
    }
    const drawnW = glyphW + gap * Math.max(0, chars.length - 1);

    const anchor = align === 'center' ? el.x + el.w / 2 : align === 'right' ? el.x + el.w : el.x;
    const left = align === 'center' ? anchor - drawnW / 2 : align === 'right' ? anchor - drawnW : anchor;

    if (el.inverse) {
      c.fillStyle = color;
      c.fillRect(left, y - size * 0.6, drawnW, size * 1.2);
    }
    c.fillStyle = el.inverse ? '#ffffff' : color;

    if (chars.length > 1 && (gap > 0 || ls > 0)) {
      let cx = left;
      chars.forEach((ch, ci) => { c.fillText(ch, cx, y); cx += widths[ci] + gap; });
    } else {
      c.fillText(ln, left, y);
    }
    if (el.underline || el.strike) {
      c.strokeStyle = c.fillStyle; c.lineWidth = Math.max(0.12, size * 0.06);
      if (el.underline) { c.beginPath(); c.moveTo(left, y + size * 0.5); c.lineTo(left + drawnW, y + size * 0.5); c.stroke(); }
      if (el.strike) { c.beginPath(); c.moveTo(left, y); c.lineTo(left + drawnW, y); c.stroke(); }
    }
  });
}

function drawBarcode(c, el, scale, opt) {
  const value = resolvedValue(el.value, opt.record, opt.batchEnabled, el) || '0';
  const hiDpi = 300;
  const pxW = Math.max(40, Math.round(el.w * hiDpi / MM));
  const pxH = Math.max(20, Math.round(el.h * hiDpi / MM));
  const bc = document.createElement('canvas');
  bc.width = pxW; bc.height = pxH;
  // textPosition supersedes displayValue: 'none' hides the human-readable text.
  const pos = el.textPosition || (el.displayValue ? 'bottom' : 'none');
  const showText = pos !== 'none';
  const modW = Math.max(1, parseFloat(el.moduleWidth) || 2);
  try {
    JsBarcode(bc, value, {
      format: el.format || 'CODE128',
      lineColor: el.lineColor || '#111111',
      background: '#ffffff',
      displayValue: showText,
      font: 'Microsoft YaHei',
      fontSize: Math.max(10, Math.round(pxH * 0.16)),
      textMargin: Math.max(0, (parseFloat(el.textGap) || 0) * hiDpi / MM),
      width: modW, margin: 0,
      height: pxH - (showText ? Math.round(pxH * 0.22) : 0)
    });
    c.drawImage(bc, el.x, el.y, el.w, el.h);
  } catch (e) {
    c.strokeStyle = '#e24b4b';
    c.strokeRect(el.x, el.y, el.w, el.h);
    c.fillStyle = '#e24b4b';
    c.font = `${Math.max(2, el.h * 0.22)}px sans-serif`;
    c.fillText('条码无效', el.x + 1, el.y + el.h / 2);
  }
}

function drawQR(c, el, opt) {
  const value = resolvedValue(el.value, opt.record, opt.batchEnabled, el) || ' ';
  try {
    const qr = QRCode.create(value, { errorCorrectionLevel: el.ec || 'M' });
    const n = qr.modules.size;
    const data = qr.modules.data;
    const quiet = 2;
    const total = n + quiet * 2;
    const cell = Math.min(el.w, el.h) / total;
    const ox = el.x + (el.w - cell * total) / 2;
    const oy = el.y + (el.h - cell * total) / 2;
    c.fillStyle = '#ffffff';
    c.fillRect(ox, oy, cell * total, cell * total);
    c.fillStyle = '#111111';
    for (let r = 0; r < n; r++) {
      for (let col = 0; col < n; col++) {
        if (data[r * n + col]) c.fillRect(ox + (col + quiet) * cell, oy + (r + quiet) * cell, cell + 0.02, cell + 0.02);
      }
    }
  } catch (e) {
    c.strokeStyle = '#e24b4b'; c.strokeRect(el.x, el.y, el.w, el.h);
  }
}

function drawImageEl(c, el) {
  if (!el.src) {
    c.strokeStyle = '#b8c2d0'; c.setLineDash([1, 1]);
    c.strokeRect(el.x, el.y, el.w, el.h); c.setLineDash([]);
    c.fillStyle = '#8a95a5'; c.font = `${Math.max(2, el.h * 0.15)}px sans-serif`;
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('双击选择图片', el.x + el.w / 2, el.y + el.h / 2);
    return;
  }
  let img = imageCache[el.src];
  if (!img || !img.complete) {
    img = new Image(); img.src = el.src; imageCache[el.src] = img;
    img.onload = () => renderCanvas();
    if (!img.complete) return;
  }
  c.save();
  if (el.opacity != null && el.opacity < 1) c.globalAlpha = Math.max(0, Math.min(1, el.opacity));
  if (el.grayscale) {
    // grayscale via temporary canvas (works for export too)
    const tw = Math.max(1, Math.round(el.w * 8)), th = Math.max(1, Math.round(el.h * 8));
    const tmp = document.createElement('canvas'); tmp.width = tw; tmp.height = th;
    const tc = tmp.getContext('2d'); tc.drawImage(img, 0, 0, tw, th);
    const id = tc.getImageData(0, 0, tw, th), d = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      d[i] = d[i + 1] = d[i + 2] = g;
    }
    tc.putImageData(id, 0, 0);
    c.drawImage(tmp, el.x, el.y, el.w, el.h);
  } else {
    c.drawImage(img, el.x, el.y, el.w, el.h);
  }
  c.restore();
}

function roundRectPath(c, x, y, w, h, r) {
  r = Math.max(0, Math.min(r || 0, Math.min(Math.abs(w), Math.abs(h)) / 2));
  c.beginPath();
  c.moveTo(x + r, y); c.lineTo(x + w - r, y); c.quadraticCurveTo(x + w, y, x + w, y + r);
  c.lineTo(x + w, y + h - r); c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  c.lineTo(x + r, y + h); c.quadraticCurveTo(x, y + h, x, y + h - r);
  c.lineTo(x, y + r); c.quadraticCurveTo(x, y, x + r, y); c.closePath();
}
function drawBlackout(c, el) {
  const r = Math.max(0, Math.min(el.radius || 0, Math.min(el.w, el.h) / 2));
  c.fillStyle = el.fill || '#000000';
  if (r > 0) { roundRectPath(c, el.x, el.y, el.w, el.h, r); c.fill(); }
  else c.fillRect(el.x, el.y, el.w, el.h);
}
function drawRect(c, el) {
  c.fillStyle = el.fill || '#fff';
  if (el.radius > 0) {
    roundRectPath(c, el.x, el.y, el.w, el.h, el.radius);
    c.fill();
    if (el.strokeWidth > 0) { c.strokeStyle = el.stroke || '#111'; c.lineWidth = el.strokeWidth; c.stroke(); }
  } else {
    c.fillRect(el.x, el.y, el.w, el.h);
    if (el.strokeWidth > 0) { c.strokeStyle = el.stroke || '#111'; c.lineWidth = el.strokeWidth; c.strokeRect(el.x, el.y, el.w, el.h); }
  }
}
function drawTriangle(c, el) {
  c.beginPath();
  c.moveTo(el.x + el.w / 2, el.y);
  c.lineTo(el.x + el.w, el.y + el.h);
  c.lineTo(el.x, el.y + el.h);
  c.closePath();
  c.fillStyle = el.fill || '#fff'; c.fill();
  if (el.strokeWidth > 0) { c.strokeStyle = el.stroke || '#111'; c.lineWidth = el.strokeWidth; c.stroke(); }
}
function drawEllipse(c, el) {
  c.beginPath();
  c.ellipse(el.x + el.w / 2, el.y + el.h / 2, Math.abs(el.w / 2), Math.abs(el.h / 2), 0, 0, Math.PI * 2);
  c.fillStyle = el.fill || '#fff'; c.fill();
  if (el.strokeWidth > 0) { c.strokeStyle = el.stroke || '#111'; c.lineWidth = el.strokeWidth; c.stroke(); }
}
function drawLine(c, el) {
  c.beginPath();
  c.moveTo(el.x, el.y); c.lineTo(el.x + el.w, el.y + el.h);
  c.strokeStyle = el.stroke || '#111'; c.lineWidth = el.strokeWidth || 0.4;
  c.stroke();
}

/* ---------------- selection overlay ---------------- */
function drawGuides(c, scale) {
  // multi-selection: draw dashed boxes for all selected except primary
  const multi = getSelectedElements();
  if (multi.length > 1) {
    c.strokeStyle = '#7aa5f5'; c.lineWidth = 0.3; c.setLineDash([1, 1]);
    for (const e of multi) {
      if (e.id === selectedId) continue;
      c.strokeRect(e.x, e.y, e.w, e.h);
    }
    c.setLineDash([]);
  }
  const sel = getSelected();
  if (sel) {
    const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2;
    c.save();
    c.translate(cx, cy);
    c.rotate(sel.rotation * Math.PI / 180);
    c.translate(-cx, -cy);
    c.strokeStyle = '#2f6fed';
    c.lineWidth = 0.35 / scale * scale; // ~0.35mm
    c.setLineDash([1.2, 0.9]);
    c.strokeRect(sel.x, sel.y, sel.w, sel.h);
    c.setLineDash([]);
    const hs = handleSizeMm(scale);
    // Line = 2 round endpoints; other elements = 8 square resize handles
    const pts = handlePoints(sel);
    for (const p of pts) {
      if (sel.type === 'line') {
        c.beginPath(); c.arc(p.x, p.y, hs * 0.62, 0, Math.PI * 2);
        c.fillStyle = '#2f6fed'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 0.25; c.stroke();
      } else {
        c.fillStyle = '#fff'; c.strokeStyle = '#2f6fed'; c.lineWidth = 0.3;
        c.fillRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
        c.strokeRect(p.x - hs / 2, p.y - hs / 2, hs, hs);
      }
    }
    // rotation handle (lines stay axis-aligned, so no rotate handle for them)
    if (sel.type !== 'line') {
      const rot = rotateHandle(sel);
      c.beginPath(); c.moveTo(cx, sel.y); c.lineTo(rot.x, rot.y); c.strokeStyle = '#2f6fed'; c.lineWidth = 0.3; c.stroke();
      c.beginPath(); c.arc(rot.x, rot.y, hs * 0.7, 0, Math.PI * 2);
      c.fillStyle = '#2f6fed'; c.fill();
    }
    // table internal row/column adjust handles (orange dots at mid lines)
    if (sel.type === 'table') {
      const { xs, ys, cols, rows } = tableEdges(sel);
      const r = hs * 0.55;
      for (let col = 1; col < cols; col++) {
        c.beginPath(); c.arc(xs[col], sel.y + sel.h / 2, r, 0, Math.PI * 2);
        c.fillStyle = '#ff8c2b'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 0.2; c.stroke();
      }
      for (let row = 1; row < rows; row++) {
        c.beginPath(); c.arc(sel.x + sel.w / 2, ys[row], r, 0, Math.PI * 2);
        c.fillStyle = '#ff8c2b'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 0.2; c.stroke();
      }
      // highlight selected grid cells (merge selection)
      if (cellSel && cellSel.id === sel.id) {
        const rect = cellSelRect();
        if (rect) {
          c.fillStyle = 'rgba(47,111,246,.18)';
          c.fillRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
          c.strokeStyle = '#2f6fed'; c.lineWidth = 0.4; c.setLineDash([0.8, 0.6]);
          c.strokeRect(rect.x0, rect.y0, rect.x1 - rect.x0, rect.y1 - rect.y0);
          c.setLineDash([]);
        }
      }
    }
    c.restore();
  }
  // alignment guides
  if (guides.length) {
    c.strokeStyle = '#ff3d7f'; c.lineWidth = 0.3;
    for (const g of guides) {
      c.beginPath();
      if (g.axis === 'x') { c.moveTo(g.pos, g.a); c.lineTo(g.pos, g.b); }
      else { c.moveTo(g.a, g.pos); c.lineTo(g.b, g.pos); }
      c.stroke();
    }
  }
}

function handleSizeMm(scale) { return 8 / scale; } // constant 8 screen px

function handlePoints(el) {
  const { x, y, w, h } = el;
  // Lines expose only two endpoints (start / end) instead of 8 resize handles.
  if (el.type === 'line') {
    return [
      { k: 'p1', x, y },
      { k: 'p2', x: x + w, y: y + h }
    ];
  }
  return [
    { k: 'nw', x, y }, { k: 'n', x: x + w / 2, y }, { k: 'ne', x: x + w, y },
    { k: 'e', x: x + w, y: y + h / 2 }, { k: 'se', x: x + w, y: y + h },
    { k: 's', x: x + w / 2, y: y + h }, { k: 'sw', x, y: y + h },
    { k: 'w', x, y: y + h / 2 }
  ];
}
function rotateHandle(el) { return { x: el.x + el.w / 2, y: el.y - 10 }; }
function rotateHandleScreen(el) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  const p = rotateHandle(el);
  const a = el.rotation * Math.PI / 180;
  const dx = p.x - cx, dy = p.y - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

/* ---------------- coordinate helpers ---------------- */
function eventToMm(evt) {
  const r = canvas.getBoundingClientRect();
  const s = scaleFactor();
  return {
    x: (evt.clientX - r.left) / s - EDITOR_PAD_MM,
    y: (evt.clientY - r.top) / s - EDITOR_PAD_MM
  };
}
function pointInElement(el, p) {
  const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
  const a = -(el.rotation || 0) * Math.PI / 180;
  const dx = p.x - cx, dy = p.y - cy;
  const lx = cx + dx * Math.cos(a) - dy * Math.sin(a);
  const ly = cy + dx * Math.sin(a) + dy * Math.cos(a);
  const pad = 0.6;
  return lx >= el.x - pad && lx <= el.x + el.w + pad && ly >= el.y - pad && ly <= el.y + el.h + pad;
}

/* ---------------- interactions ---------------- */
let drag = null;

function hitHandle(p) {
  const sel = getSelected();
  if (!sel) return null;
  const tol = 9 / scaleFactor();
  if (sel.type !== 'line') {
    const rp = rotateHandleScreen(sel);
    if (Math.hypot(p.x - rp.x, p.y - rp.y) < tol) return { k: 'rot' };
  }
  const cx = sel.x + sel.w / 2, cy = sel.y + sel.h / 2;
  const a = -(sel.rotation || 0) * Math.PI / 180;
  const dx = p.x - cx, dy = p.y - cy;
  const lx = cx + dx * Math.cos(a) - dy * Math.sin(a);
  const ly = cy + dx * Math.sin(a) + dy * Math.cos(a);
  for (const hp of handlePoints(sel)) {
    if (Math.abs(lx - hp.x) < tol && Math.abs(ly - hp.y) < tol) return { k: hp.k };
  }
  // table internal column / row resize handles (on internal grid lines)
  if (sel.type === 'table') {
    const { xs, ys, cols, rows } = tableEdges(sel);
    for (let c = 1; c < cols; c++) {
      const hx = xs[c], hy = sel.y + sel.h / 2;
      if (Math.abs(lx - hx) < tol && Math.abs(ly - hy) < tol) return { k: 'col', index: c, localX: lx, localY: hy };
    }
    for (let r = 1; r < rows; r++) {
      const hx = sel.x + sel.w / 2, hy = ys[r];
      if (Math.abs(lx - hx) < tol && Math.abs(ly - hy) < tol) return { k: 'row', index: r, localX: hx, localY: hy };
    }
  }
  return null;
}

canvas.addEventListener('mousedown', (ev) => {
  const p = eventToMm(ev);
  // Drag-to-draw a snapped horizontal/vertical line.
  if (drawMode === 'line' && ev.button === 0) {
    ev.preventDefault();
    linePreview = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
    drag = { mode: 'drawline', start: p };
    renderCanvas();
    return;
  }
  const additive = ev.ctrlKey || ev.metaKey || ev.shiftKey;
  const sel = getSelected();
  const hh = hitHandle(p);
  if (hh && sel && !sel.locked) {
    const targets = getSelectedElements().map(e => JSON.parse(JSON.stringify(e)));
    drag = { mode: hh.k, start: p, orig: JSON.parse(JSON.stringify(sel)), index: hh.index, targets };
    return;
  }
  // topmost hit (skip hidden). Transparent, border-only shapes must not
  // swallow clicks: they have no interior so hit-testing the interior should
  // fall through to whatever is underneath (e.g. text covered by a frame).
  let hit = null;
  for (let i = doc.elements.length - 1; i >= 0; i--) {
    const e = doc.elements[i];
    if (e.hidden) continue;
    if ((e.type === 'rect' || e.type === 'ellipse' || e.type === 'triangle') &&
        (e.fill === 'transparent' || e.fill === 'none' || !e.fill)) continue;
    if (pointInElement(e, p)) { hit = e; break; }
  }
  // Clicking INSIDE an already-selected table starts a cell selection drag;
  // first click just selects the table (so it can still be moved normally).
  if (hit && hit.type === 'table' && isSelected(hit.id) && !hit.locked && !additive) {
    const cx = hit.x + hit.w / 2, cy = hit.y + hit.h / 2;
    const a = -(hit.rotation || 0) * Math.PI / 180;
    const ddx = p.x - cx, ddy = p.y - cy;
    const lp = { x: cx + ddx * Math.cos(a) - ddy * Math.sin(a), y: cy + ddx * Math.sin(a) + ddy * Math.cos(a) };
    const cell = pointToCell(hit, lp);
    if (cell) {
      // snap to the top-left of any merged region the click lands in
      const mg = mergeAt(hit, cell.r, cell.c);
      const r0 = mg ? mg.r : cell.r, c0 = mg ? mg.c : cell.c;
      cellSel = { id: hit.id, r0, c0, r1: r0, c1: c0 };
      hideCellMergeBar();
      drag = { mode: 'cellsel', start: p };
      renderCanvas();
      return;
    }
  }
  if (hit) {
    if (additive) {
      toggleSelect(hit.id);
    } else if (!isSelected(hit.id)) {
      selectOnly(hit.id);
    }
    cellSel = null; hideCellMergeBar();
    const cur = getSelected();
    if (cur && !cur.locked) {
      const targets = getSelectedElements().filter(e => !e.locked).map(e => JSON.parse(JSON.stringify(e)));
      drag = { mode: 'move', start: p, orig: JSON.parse(JSON.stringify(cur)), targets };
    }
    refreshSelectionUI();
  } else {
    if (!additive) selectOnly(null);
    cellSel = null; hideCellMergeBar();
    refreshSelectionUI();
  }
  renderCanvas();
});

// ---- Inline text editing: double-click a text/barcode/QR element --------
let inlineEditor = null;
function editableKey(el) {
  if (el.type === 'text') return 'text';
  if (el.type === 'barcode' || el.type === 'qrcode') return 'value';
  return null;
}
function beginInlineEdit(el) {
  const key = editableKey(el);
  if (!el || !key || el.locked || el.hidden) return;
  closeInlineEdit(false);
  const wrap = $('#canvasWrap'); if (!wrap) return;
  if ($('#welcomeEmpty')) $('#welcomeEmpty').hidden = true;
  const s = scaleFactor();
  const ta = document.createElement('input');
  ta.type = 'text';
  ta.className = 'inline-edit';
  // input is single-line: flatten any newlines for quick editing. Multi-line
  // text can still be edited in the right-side properties panel textarea.
  ta.value = el[key] == null ? '' : String(el[key]).replace(/\r?\n/g, ' ');
  // Match the canvas text size exactly: canvas draws with fontSize in mm units
  // under ctx.scale(scale), so on screen that is fontSize * scale CSS pixels.
  const fsPx = Math.max(1, fontPx(el) * s);
  // Canvas is drawn with an editor margin (EDITOR_PAD_MM) offset; the inline
  // input is positioned relative to the canvas element, so add the same pad.
  ta.style.left = ((el.x + EDITOR_PAD_MM) * s) + 'px';
  ta.style.top = ((el.y + EDITOR_PAD_MM) * s) + 'px';
  ta.style.width = Math.max(40, el.w * s) + 'px';
  ta.style.height = Math.max(fsPx * 1.4, el.h * s) + 'px';
  ta.style.fontFamily = el.fontFamily || 'Microsoft YaHei';
  ta.style.fontSize = fsPx + 'px';
  // Match the canvas justify/distribute spacing: the renderer spreads glyphs
  // across el.w, so reproduce that with CSS letter-spacing while editing.
  let lsPx = (el.letterSpacing || 0) * s;
  const al = ['center','right','justify','distribute'].indexOf(el.align) >= 0 ? el.align : 'left';
  if ((al === 'justify' || al === 'distribute') && el[key]) {
    const probe = document.createElement('canvas').getContext('2d');
    const pfam = String(el.fontFamily || 'Microsoft YaHei').split(',')[0].trim().replace(/^["']|["']$/g, '');
    probe.font = `${el.bold ? '700 ' : '400 '}${fontPx(el)}px "${pfam}", sans-serif`;
    const chars = Array.from(String(el[key]));
    const glyphW = chars.reduce((a, ch) => a + probe.measureText(ch).width, 0);
    if (chars.length > 1 && glyphW < el.w) lsPx = (el.w - glyphW) / (chars.length - 1) * s;
  }
  ta.style.letterSpacing = lsPx + 'px';
  ta.style.fontWeight = el.bold ? '700' : '400';
  ta.style.fontStyle = el.italic ? 'italic' : 'normal';
  ta.style.color = el.color || '#111';
  ta.style.textAlign = (el.align === 'center' || el.align === 'right') ? el.align : 'left';
  let committed = false;
  const finish = (save) => {
    if (committed || ta._cancelled) return; committed = true;
    if (save) {
      el[key] = ta.value;
      commit();
    }
    if (inlineEditor === ta) inlineEditor = null;
    ta.remove();
    renderCanvas(); refreshProps();
  };
  ta._finish = finish;
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    else if (e.key === 'Enter') { e.preventDefault(); finish(true); }
  });
  wrap.appendChild(ta);
  inlineEditor = ta;
  ta.focus(); ta.select();
}
// Edit a single table cell's text with a floating input anchored to the cell.
function editTableCell(table, r, c) {
  closeInlineEdit(false);
  const wrap = $('#canvasWrap'); if (!wrap) return;
  const s = scaleFactor();
  const { xs, ys } = tableEdges(table);
  const x0 = xs[c], x1 = xs[c + 1], y0 = ys[r], y1 = ys[r + 1];
  const ta = document.createElement('input');
  ta.type = 'text'; ta.className = 'inline-edit';
  const key = r + ',' + c;
  ta.value = (table.cells && table.cells[key]) || '';
  ta.style.left = ((x0 + EDITOR_PAD_MM) * s) + 'px';
  ta.style.top = ((y0 + EDITOR_PAD_MM) * s) + 'px';
  ta.style.width = Math.max(30, (x1 - x0) * s) + 'px';
  ta.style.height = Math.max(20, (y1 - y0) * s) + 'px';
  ta.style.fontSize = Math.max(11, (table.cellFontSize || 3) * s) + 'px';
  ta.style.textAlign = 'center';
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    if (save) {
      if (!table.cells) table.cells = {};
      const v = ta.value.trim();
      if (v) table.cells[key] = v; else delete table.cells[key];
      commit();
    }
    if (ta.parentNode) ta.remove();
    renderCanvas();
  };
  ta._finish = finish;
  ta.addEventListener('blur', () => finish(true));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  wrap.appendChild(ta);
  inlineEditor = ta;
  ta.focus(); ta.select();
}

function closeInlineEdit(save) {
  if (!inlineEditor) return;
  const ta = inlineEditor; inlineEditor = null;
  ta._cancelled = true; // prevent the pending blur handler from committing
  if (save && ta._finish) ta._finish(true);
  if (ta.parentNode) ta.remove();
  renderCanvas();
}
canvas.addEventListener('dblclick', (ev) => {
  const p = eventToMm(ev);
  // Table cell: edit its text content inline.
  for (let i = doc.elements.length - 1; i >= 0; i--) {
    const t = doc.elements[i];
    if (t.hidden || t.type !== 'table') continue;
    const cx = t.x + t.w / 2, cy = t.y + t.h / 2;
    const a = -(t.rotation || 0) * Math.PI / 180;
    const ddx = p.x - cx, ddy = p.y - cy;
    const lp = { x: cx + ddx * Math.cos(a) - ddy * Math.sin(a), y: cy + ddx * Math.sin(a) + ddy * Math.cos(a) };
    const cell = pointToCell(t, lp);
    if (!cell) continue;
    ev.preventDefault();
    selectOnly(t.id);
    editTableCell(t, cell.r, cell.c);
    refreshSelectionUI();
    return;
  }
  for (let i = doc.elements.length - 1; i >= 0; i--) {
    const e = doc.elements[i];
    if (!e.hidden && pointInElement(e, p) && editableKey(e)) {
      ev.preventDefault();
      selectOnly(e.id);
      beginInlineEdit(e);
      refreshSelectionUI();
      return;
    }
  }
});

function refreshSelectionUI() {
  refreshLayers(); refreshProps(); updateStatus();
}

window.addEventListener('mousemove', (ev) => {
  if (!drag) {
    const p = eventToMm(ev);
    $('#cursorInfo').textContent = `X ${p.x.toFixed(1)}  Y ${p.y.toFixed(1)} mm`;
    return;
  }
  const p = eventToMm(ev);
  const dx = p.x - drag.start.x, dy = p.y - drag.start.y;

  if (drag.mode === 'drawline' && linePreview) {
    // Always snap to the dominant axis: lines stay perfectly horizontal or
    // vertical, never slanted. Whichever delta is larger wins.
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (ax >= ay) linePreview = { x1: drag.start.x, y1: drag.start.y, x2: p.x, y2: drag.start.y };
    else linePreview = { x1: drag.start.x, y1: drag.start.y, x2: drag.start.x, y2: p.y };
    renderCanvas();
    return;
  }

  const el = getSelected();
  if (!el) return;
  if (drag.mode === 'cellsel' && cellSel && el.type === 'table') {
    const cx = el.x + el.w / 2, cy = el.y + el.h / 2;
    const a = -(el.rotation || 0) * Math.PI / 180;
    const ddx = p.x - cx, ddy = p.y - cy;
    const lp = { x: cx + ddx * Math.cos(a) - ddy * Math.sin(a), y: cy + ddx * Math.sin(a) + ddy * Math.cos(a) };
    const cell = pointToCell(el, lp);
    if (cell) {
      const mg = mergeAt(el, cell.r, cell.c);
      cellSel.r1 = mg ? Math.min(el.rows - 1, mg.r + mg.rs - 1) : cell.r;
      cellSel.c1 = mg ? Math.min(el.cols - 1, mg.c + mg.cs - 1) : cell.c;
    }
    renderCanvas();
    return;
  }

  // Endpoint drag for lines. The drag direction decides the axis: dragging
  // mostly up/down gives a vertical line, mostly left/right a horizontal one.
  // The opposite endpoint stays fixed. Lines are always exactly orthogonal.
  if ((drag.mode === 'p1' || drag.mode === 'p2') && el.type === 'line') {
    const o = drag.orig;
    // fixed point = the endpoint we are NOT dragging
    const fixed = drag.mode === 'p1'
      ? { x: o.x + o.w, y: o.y + o.h }   // dragging start -> end is fixed
      : { x: o.x, y: o.y };              // dragging end -> start is fixed
    // Decide the axis from the mouse's own movement this drag (dx/dy), not
    // from the offset to the fixed point — a horizontal line already has a
    // large x offset, which would wrongly bias every drag to horizontal.
    const mdx = p.x - drag.start.x, mdy = p.y - drag.start.y;
    const vertical = Math.abs(mdy) > Math.abs(mdx);
    let x1, y1, x2, y2;
    if (!vertical) {
      // horizontal: keep fixed.y, extend in x
      x1 = Math.min(fixed.x, p.x); x2 = Math.max(fixed.x, p.x);
      y1 = y2 = fixed.y;
    } else {
      // vertical: keep fixed.x, extend in y
      x1 = x2 = fixed.x;
      y1 = Math.min(fixed.y, p.y); y2 = Math.max(fixed.y, p.y);
    }
    el.x = round(x1); el.y = round(y1);
    el.w = round(x2 - x1); el.h = round(y2 - y1);
    guides = [];
    renderCanvas();
    return;
  }

  if (drag.mode === 'move') {
    const targets = drag.targets || [drag.orig];
    targets.forEach(o => {
      const target = doc.elements.find(e => e.id === o.id);
      if (!target || target.locked) return;
      target.x = round(o.x + dx); target.y = round(o.y + dy);
    });
    if (targets.length === 1) computeSnapGuides(el);
  } else if (drag.mode === 'rot') {
    const cx = drag.orig.x + drag.orig.w / 2, cy = drag.orig.y + drag.orig.h / 2;
    const a0 = Math.atan2(drag.start.y - cy, drag.start.x - cx);
    const a1 = Math.atan2(p.y - cy, p.x - cx);
    let deg = (a1 - a0) * 180 / Math.PI + drag.orig.rotation;
    if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
    el.rotation = Math.round(deg * 10) / 10;
    guides = [];
  } else if (drag.mode === 'col' || drag.mode === 'row') {
    // Adjust adjacent column/row ratios by drag distance (in local mm).
    // IMPORTANT: base the math on the ratios captured at drag START, not the
    // live el ratios — otherwise each mousemove re-applies the cumulative
    // delta on top of the already-updated value and the boundary races away
    // from the cursor (the "unnatural" jump).
    const a = -(el.rotation || 0) * Math.PI / 180;
    const ldx = dx * Math.cos(a) - dy * Math.sin(a);
    const ldy = dx * Math.sin(a) + dy * Math.cos(a);
    const isCol = drag.mode === 'col';
    const key = isCol ? 'colRatios' : 'rowRatios';
    const idx = drag.index; // boundary between idx-1 and idx
    const total = isCol ? drag.orig.w : drag.orig.h;
    const base = tableRatios(drag.orig, isCol ? 'col' : 'row');
    const sum = base.reduce((s, r) => s + (r > 0 ? r : 0.01), 0) || 1;
    const delta = ((isCol ? ldx : ldy) / total) * sum; // convert mm -> ratio units
    const minR = 0.05;
    let left = base[idx - 1], right = base[idx]; // from the drag-start snapshot
    const moved = Math.max(minR - left, Math.min(right - minR, delta));
    left = Math.max(minR, left + moved);
    right = Math.max(minR, right - moved);
    const ratios = base.slice();
    ratios[idx - 1] = round(left); ratios[idx] = round(right);
    el[key] = ratios;
    guides = [];
  } else {
    resizeElement(el, drag.mode, drag.orig, dx, dy, ev.shiftKey);
    guides = [];
  }
  renderCanvas();
});

window.addEventListener('mouseup', () => {
  if (drag) {
    const wasDrawLine = drag.mode === 'drawline';
    const wasCellSel = drag.mode === 'cellsel';
    drag = null; guides = [];
    if (wasDrawLine) {
      if (linePreview) {
        const { x1, y1, x2, y2 } = linePreview;
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len >= 1) {
          const el = defaultElement('line');
          el.x = x1; el.y = y1; el.w = x2 - x1; el.h = y2 - y1;
          doc.elements.push(el);
          selectedId = el.id; selectedIds = [el.id];
          commit(); refreshAll();
        }
      }
      linePreview = null;
      setDrawMode(null);
      renderCanvas();
      return;
    }
    if (wasCellSel && cellSel) {
      const { r0, c0, r1, c1 } = cellSel;
      const spans = (Math.abs(r1 - r0) + 1) * (Math.abs(c1 - c0) + 1);
      if (spans > 1) showCellMergeBar(); else { cellSel = null; hideCellMergeBar(); renderCanvas(); }
      return;
    }
    commit(); refreshAll();
  }
});

function round(v) { return Math.round(v * 100) / 100; }

function resizeElement(el, k, o, dx, dy, keepRatio) {
  let { x, y, w, h } = o;
  // work in element's local (unrotated) frame
  const cx = o.x + o.w / 2, cy = o.y + o.h / 2;
  const a = -(o.rotation || 0) * Math.PI / 180;
  const ldx = dx * Math.cos(a) - dy * Math.sin(a);
  const ldy = dx * Math.sin(a) + dy * Math.cos(a);
  const min = 3;
  if (k.includes('w')) { x = o.x + ldx; w = o.w - ldx; }
  if (k.includes('e')) { w = o.w + ldx; }
  if (k.includes('n')) { y = o.y + ldy; h = o.h - ldy; }
  if (k.includes('s')) { h = o.h + ldy; }
  if (k === 'n' || k === 's') { /* vertical only handled above */ }
  if (keepRatio && (k.length === 2)) {
    const ratio = o.w / Math.max(o.h, 0.01);
    if (Math.abs(ldx) > Math.abs(ldy)) h = w / ratio; else w = h * ratio;
    if (k.includes('w')) x = o.x + o.w - w;
    if (k.includes('n')) y = o.y + o.h - h;
  }
  // Lines must stay axis-aligned: keep the dominant axis, zero the other so
  // dragging a handle can never make a line slanted.
  if (el.type === 'line') {
    if (Math.abs(o.w) >= Math.abs(o.h)) { h = 0; y = o.y; if (w < 0) { w = Math.abs(w); x = o.x - w; } }
    else { w = 0; x = o.x; if (h < 0) { h = Math.abs(h); y = o.y - h; } }
  }
  if (el.type !== 'line') {
    if (w < min) { if (k.includes('w')) x = o.x + o.w - min; w = min; }
    if (h < min) { if (k.includes('n')) y = o.y + o.h - min; h = min; }
  }
  Object.assign(el, { x: round(x), y: round(y), w: round(w), h: round(h) });
}

function computeSnapGuides(el) {
  guides = [];
  const thresh = 1.2;
  const others = doc.elements.filter(e => e.id !== el.id);
  const targetsX = [0, doc.width / 2, doc.width];
  const targetsY = [0, doc.height / 2, doc.height];
  others.forEach(o => { targetsX.push(o.x, o.x + o.w / 2, o.x + o.w); targetsY.push(o.y, o.y + o.h / 2, o.y + o.h); });
  const myX = [el.x, el.x + el.w / 2, el.x + el.w];
  const myY = [el.y, el.y + el.h / 2, el.y + el.h];
  let bestX = null, bestY = null, bx = thresh, by = thresh;
  myX.forEach(mx => targetsX.forEach(tx => { const d = Math.abs(mx - tx); if (d < bx) { bx = d; bestX = { delta: tx - mx, pos: tx }; } }));
  myY.forEach(my => targetsY.forEach(ty => { const d = Math.abs(my - ty); if (d < by) { by = d; bestY = { delta: ty - my, pos: ty }; } }));
  if (bestX) { el.x = round(el.x + bestX.delta); guides.push({ axis: 'x', pos: bestX.pos, a: -2, b: doc.height + 2 }); }
  if (bestY) { el.y = round(el.y + bestY.delta); guides.push({ axis: 'y', pos: bestY.pos, a: -2, b: doc.width + 2 }); }
}

/* ---------------- keyboard ---------------- */
document.addEventListener('keydown', (ev) => {
  const tag = (ev.target.tagName || '').toLowerCase();
  const typing = ['input', 'textarea', 'select'].includes(tag);
  const mod = ev.ctrlKey || ev.metaKey;
  const key = ev.key.toLowerCase();
  if (mod && key === 't') { ev.preventDefault(); newTab(); return; }
  if (mod && key === 'w') { ev.preventDefault(); if (activeTabId) closeTab(activeTabId); return; }
  if (mod && key === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); return; }
  if (mod && key === 'y') { ev.preventDefault(); redo(); return; }
  if (mod && key === 'd') { ev.preventDefault(); duplicate(); return; }
  if (mod && key === 'c') { ev.preventDefault(); copySelected(); return; }
  if (mod && key === 'v') { ev.preventDefault(); pasteClipboard(); return; }
  if (mod && key === 'a') { ev.preventDefault(); selectAll(); return; }
  if (typing) return;
  if (ev.key === 'Escape' && drawMode) { ev.preventDefault(); setDrawMode(null); return; }
  if (ev.key === 'Delete' || ev.key === 'Backspace') { ev.preventDefault(); removeSelected(); return; }
  if (key === 'l' && !mod) { ev.preventDefault(); toggleLock(); return; }
  if (key === 'h' && !mod) { ev.preventDefault(); toggleHidden(); return; }
  const els = getSelectedElements().filter(e => !e.locked);
  if (!els.length) return;
  const step = ev.shiftKey ? 0.1 : 1;
  let used = true;
  if (ev.key === 'ArrowLeft') els.forEach(e => e.x = round(e.x - step));
  else if (ev.key === 'ArrowRight') els.forEach(e => e.x = round(e.x + step));
  else if (ev.key === 'ArrowUp') els.forEach(e => e.y = round(e.y - step));
  else if (ev.key === 'ArrowDown') els.forEach(e => e.y = round(e.y + step));
  else used = false;
  if (used) { ev.preventDefault(); commit(); refreshAll(); }
});

function selectAll() {
  selectedIds = doc.elements.filter(e => !e.hidden).map(e => e.id);
  selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : null;
  refreshSelectionUI(); renderCanvas();
}
function copySelected() {
  const els = getSelectedElements();
  if (!els.length) return;
  clipboard = els.map(e => JSON.parse(JSON.stringify(e)));
  toast('已复制 ' + clipboard.length + ' 个元素');
}
function pasteClipboard() {
  if (!clipboard.length) return;
  const copies = clipboard.map(e => {
    const c = JSON.parse(JSON.stringify(e));
    c.id = uid(); c.x += 4; c.y += 4; c.locked = false;
    c.name = (e.name || typeName(e.type)) + ' 副本';
    return c;
  });
  doc.elements.push(...copies);
  selectOnly(copies[copies.length - 1].id);
  commit(); refreshAll();
  toast('已粘贴 ' + copies.length + ' 个元素');
}
function duplicate() {
  const els = getSelectedElements(); if (!els.length) return;
  const copies = els.map(el => {
    const copy = JSON.parse(JSON.stringify(el));
    copy.id = uid(); copy.x += 3; copy.y += 3; copy.locked = false;
    copy.name = (el.name || typeName(el.type)) + ' 副本';
    return copy;
  });
  doc.elements.push(...copies);
  selectedIds = copies.map(c => c.id); selectedId = copies[copies.length - 1].id;
  commit(); refreshAll();
}
function removeSelected() {
  const ids = getSelectedElements().filter(e => !e.locked).map(e => e.id);
  if (!ids.length) return;
  doc.elements = doc.elements.filter(e => !ids.includes(e.id));
  selectOnly(null); commit(); refreshAll();
}
function toggleLock() {
  const els = getSelectedElements(); if (!els.length) return;
  const target = !els.every(e => e.locked);
  els.forEach(e => e.locked = target);
  commit(); refreshAll();
}
function toggleHidden() {
  const els = getSelectedElements(); if (!els.length) return;
  const target = !els.every(e => e.hidden);
  els.forEach(e => e.hidden = target);
  commit(); refreshAll();
}

/* ---------------- alignment & distribution ---------------- */
function alignElements(mode) {
  const els = getSelectedElements().filter(e => !e.locked);
  if (els.length < 2) { toast('请选中至少 2 个元素'); return; }
  const minX = Math.min(...els.map(e => e.x)), maxX = Math.max(...els.map(e => e.x + e.w));
  const minY = Math.min(...els.map(e => e.y)), maxY = Math.max(...els.map(e => e.y + e.h));
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  if (mode === 'left') els.forEach(e => e.x = minX);
  else if (mode === 'right') els.forEach(e => e.x = maxX - e.w);
  else if (mode === 'hcenter') els.forEach(e => e.x = round(cx - e.w / 2));
  else if (mode === 'top') els.forEach(e => e.y = minY);
  else if (mode === 'bottom') els.forEach(e => e.y = maxY - e.h);
  else if (mode === 'vcenter') els.forEach(e => e.y = round(cy - e.h / 2));
  else if (mode === 'sameW') { const w = Math.max(...els.map(e => e.w)); els.forEach(e => e.w = w); }
  else if (mode === 'sameH') { const h = Math.max(...els.map(e => e.h)); els.forEach(e => e.h = h); }
  else if (mode === 'sameSize') {
    const w = Math.max(...els.map(e => e.w)), h = Math.max(...els.map(e => e.h));
    els.forEach(e => { e.w = w; e.h = h; });
  }
  else if (mode === 'distH' || mode === 'distV') {
    const axis = mode === 'distH' ? 'x' : 'y';
    const size = mode === 'distH' ? 'w' : 'h';
    // sort by center so overlapping items still get a deterministic order
    const sorted = els.slice().sort((a, b) => (a[axis] + a[size] / 2) - (b[axis] + b[size] / 2));
    const first = sorted[0], last = sorted[sorted.length - 1];
    const totalSize = sorted.reduce((s, e) => s + e[size], 0);
    let span = (last[axis] + last[size]) - first[axis];
    const minGap = 2; // mm minimum spacing
    if (span < totalSize + minGap * (sorted.length - 1)) span = totalSize + minGap * (sorted.length - 1);
    const gap = (span - totalSize) / (sorted.length - 1);
    let cursor = first[axis];
    sorted.forEach(e => { e[axis] = round(cursor); cursor += e[size] + gap; });
  }
  commit(); refreshAll();
}

/* ---------------- canvas wrapper ---------------- */
function renderCanvas() {
  resizeCanvas();
  render(ctx, doc, scaleFactor(), {});
  // live line preview while drag-drawing
  if (linePreview) {
    ctx.save();
    ctx.strokeStyle = '#2f6fed'; ctx.lineWidth = 0.5; ctx.setLineDash([1.2, 0.8]);
    ctx.beginPath(); ctx.moveTo(linePreview.x1, linePreview.y1); ctx.lineTo(linePreview.x2, linePreview.y2); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#2f6fed';
    ctx.beginPath(); ctx.arc(linePreview.x1, linePreview.y1, 0.7, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(linePreview.x2, linePreview.y2, 0.7, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }
  drawRulers();
  updateStatus();
}

/* ---------------- rulers & status ---------------- */
function drawRulers() {
  const rh = $('#rulerHCanvas'), rv = $('#rulerVCanvas');
  if (!rh || !rv) return;
  const s = scaleFactor(); // px per mm on canvas
  // horizontal
  const rhW = $('#rulerH').clientWidth;
  rh.width = rhW; rh.height = 22;
  const c1 = rh.getContext('2d');
  c1.fillStyle = '#eef1f4'; c1.fillRect(0, 0, rhW, 22);
  c1.strokeStyle = '#8a95a5'; c1.fillStyle = '#5b6675'; c1.font = '9px Segoe UI';
  c1.textAlign = 'center'; c1.textBaseline = 'top';
  // label left edge = canvas wrap left + editor pad (wrap includes margin)
  const wrap = $('#canvasWrap');
  const padPx = Math.round(EDITOR_PAD_MM * s);
  const left = wrap ? wrap.offsetLeft + padPx - $('#canvasScroll').scrollLeft : 0;
  const step = s * 10; // every 10mm
  if (step > 6) {
    for (let mm = 0; mm <= doc.width + 10; mm += 10) {
      const x = left + mm * s;
      if (x < 0 || x > rhW) continue;
      c1.beginPath(); c1.moveTo(x + .5, 22); c1.lineTo(x + .5, 14); c1.stroke();
      c1.fillText(String(mm), x, 2);
      for (let t = 1; t < 10; t++) {
        const tx = x + t * s;
        if (tx > rhW) break;
        c1.beginPath(); c1.moveTo(tx + .5, 22); c1.lineTo(tx + .5, 18); c1.stroke();
      }
    }
  }
  // vertical
  const rvH = $('#rulerV').clientHeight;
  rv.width = 22; rv.height = rvH;
  const c2 = rv.getContext('2d');
  c2.fillStyle = '#eef1f4'; c2.fillRect(0, 0, 22, rvH);
  c2.strokeStyle = '#8a95a5'; c2.fillStyle = '#5b6675'; c2.font = '9px Segoe UI';
  c2.textAlign = 'center'; c2.textBaseline = 'middle';
  const top = wrap ? wrap.offsetTop + padPx - $('#canvasScroll').scrollTop : 0;
  if (step > 6) {
    for (let mm = 0; mm <= doc.height + 10; mm += 10) {
      const y = top + mm * s;
      if (y < 0 || y > rvH) continue;
      c2.beginPath(); c2.moveTo(22, y + .5); c2.lineTo(14, y + .5); c2.stroke();
      c2.save(); c2.translate(7, y); c2.rotate(-Math.PI / 2); c2.fillText(String(mm), 0, 0); c2.restore();
      for (let t = 1; t < 10; t++) {
        const ty = y + t * s;
        if (ty > rvH) break;
        c2.beginPath(); c2.moveTo(22, ty + .5); c2.lineTo(18, ty + .5); c2.stroke();
      }
    }
  }
}
function updateStatus() {
  if ($('#statusElements')) $('#statusElements').textContent = doc.elements.length + ' 个元素';
  if ($('#statusSize')) $('#statusSize').textContent = '画布 ' + doc.width + ' × ' + doc.height + ' mm';
  if ($('#statusDb')) $('#statusDb').textContent = '数据库：' + batchRows.length + ' 条';
  // Tab titles are rendered by renderTabBar() from each tab's doc.name.
  updateSelInfo();
}
$('#canvasScroll') && $('#canvasScroll').addEventListener('scroll', drawRulers);
window.addEventListener('resize', drawRulers);
function refreshAll() {
  renderCanvas();
  refreshLayers();
  refreshProps();
  syncDocFields();
}

/* ---------------- layers ---------------- */
function refreshLayers() {
  const box = $('#layerList');
  box.innerHTML = '';
  [...doc.elements].reverse().forEach(el => {
    const d = document.createElement('div');
    d.className = 'layer-item' + (isSelected(el.id) ? ' active' : '') + (el.hidden ? ' is-hidden' : '');
    d.innerHTML = `<span class="ly-ico">${typeIcon(el.type)}</span><span class="ly-name">${escapeHtml(el.name || typeName(el.type))}</span>` +
      `<button class="ly-act" data-act="lock" title="${el.locked ? '解锁' : '锁定'}">${el.locked ? '🔒' : '🔓'}</button>` +
      `<button class="ly-act" data-act="hidden" title="${el.hidden ? '显示' : '隐藏'}">${el.hidden ? '🚫' : '👁'}</button>`;
    d.onclick = (e) => {
      const act = e.target.getAttribute('data-act');
      if (act === 'lock') { el.locked = !el.locked; commit(); refreshAll(); return; }
      if (act === 'hidden') { el.hidden = !el.hidden; commit(); refreshAll(); return; }
      if (e.ctrlKey || e.metaKey || e.shiftKey) toggleSelect(el.id);
      else selectOnly(el.id);
      refreshSelectionUI(); renderCanvas();
    };
    box.appendChild(d);
  });
}

/* ---------------- properties panel ---------------- */
function refreshProps() {
  const el = getSelected();
  // Selecting an element always returns the inspector to the property view.
  const lp = $('#layersPanel');
  if (lp && !lp.hidden) {
    lp.hidden = true;
    if ($('#btnLayers')) $('#btnLayers').classList.remove('active');
  }
  const empty = $('#propsEmpty'), props = $('#props');
  if (!el) {
    empty.hidden = false; props.hidden = true;
    if ($('#propTypeLabel')) $('#propTypeLabel').textContent = '';
    refreshFormatBar(null);
    return;
  }
  empty.hidden = true; props.hidden = false;
  if ($('#propTypeLabel')) $('#propTypeLabel').textContent = '· ' + typeName(el.type);
  refreshFormatBar(el);
  const p = props;
  p.innerHTML = '';

  // Element-specific sections go on TOP; generic "常规" is appended at the end.
  // `target` starts as the main panel, then we switch to the tail container
  // when building the generic section so it renders below everything else.
  let target = p;
  const div = (cls) => { const d = document.createElement('div'); d.className = cls; return d; };
  const addText = (label, key, val, type = 'text') => {
    const row = div('prop-row');
    row.innerHTML = `<label>${label}</label>`;
    const inp = document.createElement('input');
    inp.type = type; inp.value = val != null ? val : '';
    if (type === 'number') inp.step = '0.1';
    inp.oninput = () => {
      if (type === 'number') el[key] = parseFloat(inp.value) || 0; else el[key] = inp.value;
      if (key === 'name') refreshLayers();
      renderCanvas();
    };
    inp.onchange = () => commit();
    row.appendChild(inp); target.appendChild(row);
    return inp;
  };
  const addCheck = (label, key) => {
    const row = div('prop-row prop-checks');
    const lab = document.createElement('label'); lab.className = 'chk';
    const inp = document.createElement('input'); inp.type = 'checkbox'; inp.checked = !!el[key];
    inp.onchange = () => { el[key] = inp.checked; commit(); renderCanvas(); };
    lab.appendChild(inp); lab.appendChild(document.createTextNode(label)); row.appendChild(lab); target.appendChild(row);
  };
  const addSelect = (label, key, options) => {
    const row = div('prop-row');
    row.innerHTML = `<label>${label}</label>`;
    const sel = document.createElement('select');
    options.forEach(o => {
      const op = document.createElement('option');
      op.value = o[0]; op.textContent = o[1];
      if (el[key] === o[0]) op.selected = true;
      sel.appendChild(op);
    });
    sel.onchange = () => { el[key] = sel.value; commit(); renderCanvas(); };
    row.appendChild(sel); target.appendChild(row);
  };
  const sec = (t) => { const d = div('prop-sec'); d.textContent = t; target.appendChild(d); };

  if (el.type === 'text') {
    sec('文本');
    const row = div('prop-row'); row.innerHTML = '<label>内容 (支持 {字段})</label>';
    const ta = document.createElement('textarea'); ta.value = el.text || '';
    ta.oninput = () => { el.text = ta.value; renderCanvas(); }; ta.onchange = commit;
    row.appendChild(ta); p.appendChild(row);
    addText('字号 (mm)', 'fontSize', el.fontSize, 'number');
    addSelect('字体', 'fontFamily', [['Microsoft YaHei', '微软雅黑'], ['SimHei', '黑体'], ['SimSun', '宋体'], ['Arial', 'Arial'], ['Consolas', 'Consolas']]);
    addSelect('对齐', 'align', [['left', '左'], ['center', '中'], ['right', '右']]);
    addText('字间距 (mm)', 'letterSpacing', el.letterSpacing || 0, 'number');
    addText('行间距 (倍数)', 'lineSpacing', el.lineSpacing || 1.15, 'number');
    addCheck('粗体', 'bold'); addCheck('斜体', 'italic');
    addCheck('下划线', 'underline'); addCheck('删除线', 'strike'); addCheck('反白', 'inverse');
    addColorRow('颜色', 'color', el, p, commit, renderCanvas);
    if (el.dynamic === 'date') {
      sec('日期时间');
      addSelect('类型', 'dynamic', [['date', '日期'], ['time', '时间']]);
      addText('格式', 'dateFormat', el.dateFormat || 'YYYY-MM-DD');
      addSelect('递增单位', 'dateUnit', [['day', '按日'], ['month', '按月'], ['year', '按年'], ['hour', '按时']]);
      addText('偏移步长', 'dateStep', el.dateStep || 0, 'number');
      const tip = div('side-tip'); tip.textContent = '格式代码：YYYY年 MM月 DD日 HH时 mm分 SS秒，YY两位年。偏移可按日/月/年递增。';
      tip.style.cssText = 'font-size:10.5px;color:#8a95a5;line-height:1.5;margin-top:6px'; p.appendChild(tip);
    }
  } else if (el.type === 'barcode') {
    sec('一维码 · 编码');
    addSelect('编码格式', 'format', [
      ['CODE128', 'CODE_128'], ['CODE39', 'CODE_39'], ['EAN13', 'EAN_13'],
      ['EAN8', 'EAN_8'], ['UPC', 'UPC'], ['ITF14', 'ITF-14'], ['CODABAR', 'CODABAR']
    ]);
    addSelect('文本位置', 'textPosition', [['bottom', '文本下方'], ['top', '文本上方'], ['none', '不显示']]);
    addColorRow('线条颜色', 'lineColor', el, p, commit, renderCanvas);
    sec('条码参数');
    addText('条宽密度 (mil)', 'moduleWidth', el.moduleWidth || 2, 'number');
    addText('文本间距 (mm)', 'textGap', el.textGap || 0, 'number');
    sec('条码内容');
    addText('内容 (支持 {字段})', 'value', el.value);
  } else if (el.type === 'qrcode') {
    sec('二维码');
    addText('内容 (支持 {字段})', 'value', el.value);
    addSelect('容错级别', 'ec', [['L', 'L 低'], ['M', 'M 中'], ['Q', 'Q 较高'], ['H', 'H 高']]);
    addSelect('符号版本', 'symbolVersion', [['auto', '自动'], ...Array.from({length: 10}, (_, i) => [String(i + 1), '版本 ' + (i + 1)])]);
    addSelect('字符编码', 'charset', [['ANSI', 'ANSI'], ['UTF-8', 'UTF-8'], ['GB2312', 'GB2312']]);
    addSelect('文本位置', 'textPosition', [['none', '无'], ['top', '上方'], ['bottom', '下方']]);
  } else if (el.type === 'image') {
    sec('图片');
    const row = div('prop-row');
    const btn = document.createElement('button'); btn.className = 'tb-btn';
    btn.textContent = '选择图片文件…'; btn.style.width = '100%';
    btn.onclick = () => pickImage(el);
    row.appendChild(btn); p.appendChild(row);
    if (el.src) { const im = document.createElement('img'); im.src = el.src; im.style.cssText = 'max-width:100%;max-height:120px;border:1px solid #eee'; p.appendChild(im); }
    addCheck('灰度', 'grayscale');
    const opRow = div('prop-row'); opRow.innerHTML = '<label>透明度 (0-1)</label>';
    const opInp = document.createElement('input'); opInp.type = 'number'; opInp.step = '0.1'; opInp.min = '0'; opInp.max = '1'; opInp.value = el.opacity != null ? el.opacity : 1;
    opInp.oninput = () => { el.opacity = Math.max(0, Math.min(1, parseFloat(opInp.value) || 1)); renderCanvas(); }; opInp.onchange = commit;
    opRow.appendChild(opInp); p.appendChild(opRow);
  } else if (el.type === 'rect' || el.type === 'ellipse' || el.type === 'triangle' || el.type === 'line') {
    sec('样式');
    if (el.type !== 'line') addColorRow('填充', 'fill', el, p, commit, renderCanvas);
    addColorRow('线条', 'stroke', el, p, commit, renderCanvas);
    addText('线宽 (mm)', 'strokeWidth', el.strokeWidth, 'number');
    if (el.type === 'rect') addText('圆角半径 (mm)', 'radius', el.radius || 0, 'number');
  } else if (el.type === 'blackout') {
    sec('区域反黑');
    addColorRow('填充', 'fill', el, p, commit, renderCanvas);
    addText('圆角半径 (mm)', 'radius', el.radius || 0, 'number');
  } else if (el.type === 'table') {
    sec('表格 · 行列');
    const rg = div('prop-grid');
    const mkNum = (label, key, isSize) => {
      const row = div('prop-row'); row.innerHTML = `<label>${label}</label>`;
      const inp = document.createElement('input'); inp.type = 'number'; inp.min = isSize ? '0.05' : '1';
      inp.step = isSize ? '0.05' : '1'; inp.value = el[key];
      inp.onchange = () => {
        const v = isSize ? (parseFloat(inp.value) || 0.3) : Math.max(1, parseInt(inp.value) || 1);
        el[key] = v;
        if (!isSize) {
          if (key === 'rows') { const a = tableRatios(el, 'row'); el.rowRatios = a; }
          if (key === 'cols') { const a = tableRatios(el, 'col'); el.colRatios = a; }
          // drop merges that no longer fit the new grid
          el.merges = tableMerges(el).filter(m => true);
        }
        commit(); refreshAll();
      };
      row.appendChild(inp); rg.appendChild(row);
    };
    mkNum('行数', 'rows', false); mkNum('列数', 'cols', false);
    p.appendChild(rg);
    sec('单元格文字');
    addText('字号 (mm)', 'cellFontSize', el.cellFontSize || 3, 'number');
    addSelect('字体', 'cellFontFamily', [['Microsoft YaHei', '微软雅黑'], ['SimHei', '黑体'], ['SimSun', '宋体'], ['Arial', 'Arial']]);
    addColorRow('颜色', 'cellColor', el, p, commit, renderCanvas);
    const cellTip = div('side-tip');
    cellTip.textContent = '双击单元格输入内容；右键可插入/删除行列、合并拆分';
    p.appendChild(cellTip);
    sec('线条');
    addText('线条粗细 (mm)', 'borderWidth', el.borderWidth, 'number');
    addColorRow('线条颜色', 'borderColor', el, p, commit, renderCanvas);
    const resetBtn = document.createElement('button');
    resetBtn.className = 'tb-btn'; resetBtn.textContent = '行列等宽重置';
    resetBtn.style.cssText = 'width:100%;margin-top:8px';
    resetBtn.onclick = () => { el.colRatios = new Array(el.cols).fill(1); el.rowRatios = new Array(el.rows).fill(1); commit(); refreshAll(); };
    p.appendChild(resetBtn);
    // merged cells management
    sec('单元格合并');
    const mergeCount = tableMerges(el).length;
    const mergeInfo = div('side-tip');
    mergeInfo.textContent = mergeCount ? ('已合并 ' + mergeCount + ' 处') : '暂无合并';
    mergeInfo.style.cssText = 'font-size:11px;color:#5a6a82;margin-bottom:6px';
    p.appendChild(mergeInfo);
    if (mergeCount) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'tb-btn'; clearBtn.textContent = '清除全部合并';
      clearBtn.style.cssText = 'width:100%';
      clearBtn.onclick = () => { el.merges = []; commit(); refreshAll(); };
      p.appendChild(clearBtn);
    }
    const hint = div('side-tip');
    hint.textContent = '合并：选中表格后在格子上按住鼠标拖选多个格，松开后点“合并”。点“拆分”可还原。拖内部橙色圆点调整行高/列宽。';
    hint.style.cssText = 'font-size:10.5px;color:#8a95a5;line-height:1.5;margin-top:8px';
    p.appendChild(hint);
  }

  // ---- Generic "常规" section, rendered at the BOTTOM ----
  const tail = div('prop-tail');
  target = tail;
  // Data binding section: pick a column instead of typing a name.
  sec('数据绑定');
  const fieldOpts = [['', '（不绑定 · 用下方内容）']];
  (batchHeaders || []).forEach(h => fieldOpts.push([h, '列：' + h]));
  fieldOpts.push(['序列号', '序列号'], ['日期', '日期']);
  // keep a custom value selectable even if not in the header list
  if (el.field && !(batchHeaders || []).includes(el.field) && el.field !== '序列号' && el.field !== '日期') {
    fieldOpts.push([el.field, el.field]);
  }
  addSelect('绑定列', 'field', fieldOpts);
  const bindTip = div('side-tip');
  bindTip.textContent = '绑定后打印时该元素显示这一列的值；也可在内容里写 {列名}、{序列号}、{日期} 做模板替换。';
  bindTip.style.cssText = 'font-size:10.5px;color:#8a95a5;line-height:1.5;margin:2px 0 6px';
  tail.appendChild(bindTip);

  sec('常规');
  // NOTE: the "名称" field is intentionally hidden per UI request.
  const grid = div('prop-grid');
  const gx = div('prop-row'); gx.innerHTML = '<label>X (mm)</label>';
  const ix = document.createElement('input'); ix.type = 'number'; ix.step = '0.1'; ix.value = el.x;
  ix.oninput = () => { el.x = parseFloat(ix.value) || 0; renderCanvas(); }; ix.onchange = commit; gx.appendChild(ix); grid.appendChild(gx);
  const gy = div('prop-row'); gy.innerHTML = '<label>Y (mm)</label>';
  const iy = document.createElement('input'); iy.type = 'number'; iy.step = '0.1'; iy.value = el.y;
  iy.oninput = () => { el.y = parseFloat(iy.value) || 0; renderCanvas(); }; iy.onchange = commit; gy.appendChild(iy); grid.appendChild(gy);
  const gw = div('prop-row'); gw.innerHTML = '<label>宽 (mm)</label>';
  const iw = document.createElement('input'); iw.type = 'number'; iw.step = '0.1'; iw.value = el.w;
  iw.oninput = () => { el.w = parseFloat(iw.value) || 0; renderCanvas(); }; iw.onchange = commit; gw.appendChild(iw); grid.appendChild(gw);
  const gh = div('prop-row'); gh.innerHTML = '<label>高 (mm)</label>';
  const ih = document.createElement('input'); ih.type = 'number'; ih.step = '0.1'; ih.value = el.h;
  ih.oninput = () => { el.h = parseFloat(ih.value) || 0; renderCanvas(); }; ih.onchange = commit; gh.appendChild(ih); grid.appendChild(gh);
  tail.appendChild(grid);
  if (el.type !== 'line') addText('旋转 (度)', 'rotation', el.rotation, 'number');
  const stateRow = div('prop-row prop-checks');
  const lockChk = document.createElement('label'); lockChk.className = 'chk';
  const li = document.createElement('input'); li.type = 'checkbox'; li.checked = !!el.locked;
  li.onchange = () => { el.locked = li.checked; commit(); refreshAll(); };
  lockChk.appendChild(li); lockChk.appendChild(document.createTextNode('🔒 锁定'));
  const hideChk = document.createElement('label'); hideChk.className = 'chk';
  const hi2 = document.createElement('input'); hi2.type = 'checkbox'; hi2.checked = !!el.hidden;
  hi2.onchange = () => { el.hidden = hi2.checked; commit(); refreshAll(); };
  hideChk.appendChild(hi2); hideChk.appendChild(document.createTextNode('👁 隐藏'));
  stateRow.appendChild(lockChk); stateRow.appendChild(hideChk); tail.appendChild(stateRow);

  sec('图层顺序');
  const ord = div('tb-group'); ord.style.cssText = 'display:flex;gap:6px';
  const bUp = document.createElement('button'); bUp.className = 'tb-btn'; bUp.textContent = '上移'; bUp.onclick = () => moveLayer(el, 1);
  const bDn = document.createElement('button'); bDn.className = 'tb-btn'; bDn.textContent = '下移'; bDn.onclick = () => moveLayer(el, -1);
  ord.appendChild(bUp); ord.appendChild(bDn); p.appendChild(ord);

  const del = document.createElement('button'); del.className = 'btn-danger'; del.textContent = '🗑 删除元素';
  del.onclick = removeSelected; tail.appendChild(del);
  // Generic section (常规 / 图层顺序 / 删除) goes last, below type-specific ones.
  p.appendChild(tail);
}

function addColorRow(label, key, el, parent, commitFn, renderFn) {
  const row = document.createElement('div'); row.className = 'prop-row';
  row.innerHTML = `<label>${label}</label>`;
  const wrap = document.createElement('div'); wrap.className = 'color-row';
  const cp = document.createElement('input'); cp.type = 'color'; cp.value = toHex(el[key] || '#111111');
  const tx = document.createElement('input'); tx.type = 'text'; tx.value = el[key] || '#111111';
  cp.oninput = () => { el[key] = cp.value; tx.value = cp.value; renderFn(); };
  cp.onchange = commitFn;
  tx.onchange = () => { el[key] = tx.value; cp.value = toHex(tx.value); commitFn(); renderFn(); };
  wrap.appendChild(cp); wrap.appendChild(tx); row.appendChild(wrap); parent.appendChild(row);
}
function toHex(c) { return /^#[0-9a-f]{6}$/i.test(c || '') ? c : '#111111'; }

function moveLayer(el, dir) {
  const i = doc.elements.indexOf(el);
  const j = i + dir;
  if (j < 0 || j >= doc.elements.length) return;
  [doc.elements[i], doc.elements[j]] = [doc.elements[j], doc.elements[i]];
  commit(); refreshAll();
}

function pickImage(el) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      el.src = r.result;
      const img = new Image(); img.src = r.result; img.onload = () => {
        if (el.w === 30 && el.h === 30) { const ratio = img.width / img.height; if (ratio > 1) el.h = el.w / ratio; else el.w = el.h * ratio; }
      };
      imageCache[r.result] = img;
      commit(); refreshAll();
    };
    r.readAsDataURL(f);
  };
  inp.click();
}

function escapeHtml(s) { return String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])); }

/* ---------------- palette / add element ---------------- */
function addElementByType(type, format) {
  const el = defaultElement(type);
  if (type === 'barcode' && format) el.format = format;
  el.x = Math.max(2, (doc.width - el.w) / 2);
  el.y = Math.max(2, (doc.height - el.h) / 2);
  doc.elements.push(el);
  selectedId = el.id; selectedIds = [el.id];
  commit(); refreshAll();
}
// Direct-add buttons (element bar + Ribbon insert tab). Sub-menu items are
// excluded here and bound separately below.
$$('.eb-item[data-add], .ribbon-big[data-add], .ribbon-small[data-add]').forEach(btn => {
  if (btn.closest('.eb-menu')) return;
  btn.onclick = () => {
    setDrawMode(null);
    addElementByType(btn.dataset.add);
    $$('.eb-item.active, .ribbon-big.active, .ribbon-small.active').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  };
});
function setDrawMode(mode) {
  drawMode = mode;
  linePreview = null;
  $$('.eb-item.active, .ribbon-big.active, .ribbon-small.active').forEach(b => b.classList.remove('active'));
  if (canvas) canvas.style.cursor = mode === 'line' ? 'crosshair' : '';
  if ($('#drawHint')) $('#drawHint').hidden = mode !== 'line';
  renderCanvas();
}
// Sub-menu items (barcode formats / shape types)
$$('.eb-menu button[data-add]').forEach(btn => {
  btn.onclick = () => {
    addElementByType(btn.dataset.add, btn.dataset.format);
    closeAllDropdowns();
    const parentBtn = btn.closest('.eb-wrap') && btn.closest('.eb-wrap').querySelector('.eb-item, .ribbon-big');
    if (parentBtn) { $$('.eb-item.active, .ribbon-big.active').forEach(b => b.classList.remove('active')); parentBtn.classList.add('active'); }
  };
});

/* ---------------- Ribbon tabs ---------------- */
$$('.ribbon-tab').forEach(tab => {
  tab.onclick = () => {
    const name = tab.dataset.ribbon;
    $$('.ribbon-tab').forEach(t => t.classList.toggle('active', t === tab));
    $$('.ribbon-panel').forEach(p => p.classList.toggle('active', p.dataset.panel === name));
    closeAllDropdowns();
  };
});

/* ---------------- dropdown menus (file / element submenus) ---------------- */
function closeAllDropdowns() {
  ['#fileMenu', '#barcodeMenu', '#shapeMenu'].forEach(sel => { const d = $(sel); if (d) d.hidden = true; });
}
function toggleDropdown(menuSel, btn) {
  const d = $(menuSel); if (!d) return;
  const willOpen = d.hidden;
  closeAllDropdowns();
  d.hidden = !willOpen;
  if (btn) btn.classList.toggle('open', willOpen);
}
if ($('#btnFileMenu')) $('#btnFileMenu').onclick = (e) => { e.stopPropagation(); toggleDropdown('#fileMenu', $('#btnFileMenu')); };
if ($('#btnBarcodeMenu')) $('#btnBarcodeMenu').onclick = (e) => { e.stopPropagation(); toggleDropdown('#barcodeMenu', $('#btnBarcodeMenu')); };
if ($('#btnShapeMenu')) $('#btnShapeMenu').onclick = (e) => { e.stopPropagation(); toggleDropdown('#shapeMenu', $('#btnShapeMenu')); };
// Click outside closes any dropdown.
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap') && !e.target.closest('.eb-wrap')) {
    closeAllDropdowns();
    ['#btnFileMenu', '#btnBarcodeMenu', '#btnShapeMenu'].forEach(s => { const b = $(s); if (b) b.classList.remove('open'); });
  }
});
// File menu actions
$$('#fileMenu button[data-act]').forEach(btn => {
  btn.onclick = () => {
    closeAllDropdowns();
    const act = btn.dataset.act;
    if (act === 'new') newTab();
    else if (act === 'open') openDocument();
    else if (act === 'save') $('#btnSave').click();
    else if (act === 'saveas') $('#btnSaveAs').click();
    else if (act === 'print') $('#btnPrint').click();
    else if (act === 'batch') { const p = $('#batchPanel'); if (p) { p.classList.remove('collapsed'); expandBatch(); } }
    else if (act === 'exit') { if (api && api.win) api.win.close(); }
  };
});

// batch panel collapse / expand
if ($('#btnBatchToggle')) $('#btnBatchToggle').onclick = () => $('#batchPanel').classList.toggle('collapsed');
function expandBatch() { $('#batchPanel').classList.remove('collapsed'); }

// layer toggle (button lives in the View ribbon tab)
if ($('#btnLayers')) $('#btnLayers').onclick = () => {
  const lp = $('#layersPanel');
  const props = $('#props'); const empty = $('#propsEmpty');
  const showLayers = lp.hidden;
  lp.hidden = !showLayers;
  if (props) props.hidden = showLayers;
  if (empty) empty.hidden = showLayers;
  $('#btnLayers').classList.toggle('active', showLayers);
};

/* ---------------- zoom ---------------- */
// The canvas area never scrolls: zoom is capped so the whole canvas (label
// plus the editor overflow margin) always fits inside the visible area.
function maxFitZoom() {
  const sc = $('#canvasScroll');
  if (!sc || !doc) return 4;
  const availW = Math.max(120, sc.clientWidth - 60);
  const availH = Math.max(120, sc.clientHeight - 60);
  const baseW = (doc.width + EDITOR_PAD_MM * 2) * pxPerMmBase;
  const baseH = (doc.height + EDITOR_PAD_MM * 2) * pxPerMmBase;
  return Math.max(0.2, Math.min(availW / baseW, availH / baseH));
}
function setZoom(z) {
  // Upper bound is the fit size, so no scrollbar / dragging is ever needed.
  zoom = Math.max(0.2, Math.min(maxFitZoom(), z));
  $('#zoomLabel').textContent = Math.round(zoom * 100) + '%';
  renderCanvas();
}
$('#zoomIn').onclick = () => setZoom(zoom * 1.25);
$('#zoomOut').onclick = () => setZoom(zoom / 1.25);
$('#zoomFit').onclick = fitZoom;
function fitZoom() {
  setZoom(maxFitZoom());
}
// Keep the whole canvas visible whenever the window size changes.
window.addEventListener('resize', () => fitZoom());
$('#showGuides').onchange = (e) => { showGuides = e.target.checked; renderCanvas(); };

/* ---------------- align bar ---------------- */
$$('.ab-btn[data-align]').forEach(b => { b.onclick = () => alignElements(b.dataset.align); });

// Batch-set the stroke width of every line/shape in the current label.
// Table grid lines use borderWidth, so they are updated too.
function applyLineWidthToAll() {
  const inp = $('#batchLineWidth');
  const w = parseFloat(inp && inp.value);
  if (!isFinite(w) || w <= 0) { toast('请输入有效的线宽（>0 mm）'); return; }
  let n = 0;
  for (const el of doc.elements) {
    if (el.type === 'line' || el.type === 'rect' || el.type === 'ellipse' || el.type === 'triangle') {
      el.strokeWidth = w; n++;
    } else if (el.type === 'table') {
      el.borderWidth = w; n++;
    }
  }
  if (!n) { toast('本标签没有线条或图形'); return; }
  commit();
  refreshAll();
  toast(`已把 ${n} 个线条/图形的线宽设为 ${w} mm`);
}
if ($('#btnApplyLineWidth')) $('#btnApplyLineWidth').onclick = applyLineWidthToAll;
if ($('#abLock')) $('#abLock').onclick = toggleLock;
if ($('#abHide')) $('#abHide').onclick = toggleHidden;
if ($('#abPaste')) $('#abPaste').onclick = pasteClipboard;
if ($('#showGrid')) $('#showGrid').onchange = (e) => { showGrid = e.target.checked; renderCanvas(); };
if ($('#gridSize')) $('#gridSize').onchange = (e) => { gridSize = Math.max(1, parseFloat(e.target.value) || 5); renderCanvas(); };
function updateSelInfo() {
  const n = getSelectedElements().length;
  if ($('#abSelInfo')) $('#abSelInfo').textContent = '选中 ' + n + ' 个';
}

/* ---------------- top buttons: undo/redo/dup/del ---------------- */
if ($('#undoBtn')) $('#undoBtn').onclick = undo;
if ($('#redoBtn')) $('#redoBtn').onclick = redo;
if ($('#dupBtn')) $('#dupBtn').onclick = duplicate;
if ($('#delBtn')) $('#delBtn').onclick = removeSelected;
if ($('#btnLabelSetup')) $('#btnLabelSetup').onclick = () => {
  $('#docW').focus(); $('#docW').select();
  toast('在右上角修改纸张宽高即可设置标签尺寸');
};

/* ---------------- format bar (text properties) ---------------- */
function refreshFormatBar(el) {
  const isText = el && el.type === 'text';
  ['fbBold','fbItalic','fbUnderline','fbStrike','fbAlignLeft','fbAlignCenter','fbAlignRight','fbAlignJustify','fbAlignDistribute','fbColor'].forEach(id => {
    const b = $('#' + id); if (b) b.disabled = !isText;
  });
  if (!isText) {
    if ($('#fbHint')) $('#fbHint').textContent = '选中文本元素后可设置字体';
    return;
  }
  if ($('#fbHint')) $('#fbHint').textContent = '';
  if ($('#fbFont')) $('#fbFont').value = el.fontFamily || 'Arial';
  if ($('#fbSize')) $('#fbSize').value = el.fontSize || 5;
  $('#fbBold').classList.toggle('active', !!el.bold);
  $('#fbItalic').classList.toggle('active', !!el.italic);
  $('#fbUnderline').classList.toggle('active', !!el.underline);
  $('#fbStrike').classList.toggle('active', !!el.strike);
  $('#fbAlignLeft').classList.toggle('active', !el.align || el.align === 'left');
  $('#fbAlignCenter').classList.toggle('active', el.align === 'center');
  $('#fbAlignRight').classList.toggle('active', el.align === 'right');
  $('#fbAlignJustify').classList.toggle('active', el.align === 'justify');
  $('#fbAlignDistribute').classList.toggle('active', el.align === 'distribute');
  if ($('#fbColorBar')) $('#fbColorBar').style.background = el.color || '#111';
}
function bindFormatBar() {
  const apply = (fn) => { const el = getSelected(); if (!el || el.type !== 'text') return; fn(el); commit(); renderCanvas(); refreshProps(); };
  if ($('#fbFont')) $('#fbFont').onchange = e => apply(el => el.fontFamily = e.target.value);
  if ($('#fbSize')) $('#fbSize').onchange = e => apply(el => el.fontSize = parseFloat(e.target.value) || 5);
  if ($('#fbBold')) $('#fbBold').onclick = () => apply(el => el.bold = !el.bold);
  if ($('#fbItalic')) $('#fbItalic').onclick = () => apply(el => el.italic = !el.italic);
  if ($('#fbUnderline')) $('#fbUnderline').onclick = () => apply(el => el.underline = !el.underline);
  if ($('#fbStrike')) $('#fbStrike').onclick = () => apply(el => el.strike = !el.strike);
  if ($('#fbAlignLeft')) $('#fbAlignLeft').onclick = () => apply(el => el.align = 'left');
  if ($('#fbAlignCenter')) $('#fbAlignCenter').onclick = () => apply(el => el.align = 'center');
  if ($('#fbAlignRight')) $('#fbAlignRight').onclick = () => apply(el => el.align = 'right');
  if ($('#fbAlignJustify')) $('#fbAlignJustify').onclick = () => apply(el => el.align = 'justify');
  if ($('#fbAlignDistribute')) $('#fbAlignDistribute').onclick = () => apply(el => el.align = 'distribute');
  if ($('#fbColor')) $('#fbColor').onclick = () => {
    const el = getSelected(); if (!el || el.type !== 'text') return;
    const inp = document.createElement('input'); inp.type = 'color'; inp.value = toHex(el.color || '#111');
    inp.onchange = () => { el.color = inp.value; commit(); renderCanvas(); refreshProps(); };
    inp.click();
  };
}
bindFormatBar();

/* ---------------- doc fields ---------------- */
function syncDocFields() { $('#docW').value = doc.width; $('#docH').value = doc.height; }
function bindDocSize() {
  ['docW', 'docH'].forEach(id => {
    $('#' + id).addEventListener('change', (e) => {
      const v = parseFloat(e.target.value);
      if (!v || v < 10) { syncDocFields(); return; }
      if (id === 'docW') doc.width = v; else doc.height = v;
      commit(); refreshAll();
    });
  });
}

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- file: new / save / save-as ---------------- */
// currentFile tracks the last opened/saved file so "Save" can overwrite it.
let currentFile = null; // { path, type: 'xtc'|'ddl' }

/* ---------------- document tabs (multi-document) ---------------- */
// Each tab owns a full document session. The existing global variables (doc,
// currentFile, selectedId(s), history/hi, batch data) keep representing the
// ACTIVE document, so all the editing/rendering code stays untouched. On tab
// switch we save globals back to the current tab and load the target tab in.
const tabs = [];
let activeTabId = null;

function makeTab(docObj, file) {
  return {
    id: 'tab_' + Math.random().toString(36).slice(2, 9),
    doc: docObj || makeDoc(),
    currentFile: file || null,
    selectedId: null, selectedIds: [],
    history: [], hi: -1,
    batchRows: [], batchHeaders: []
  };
}
function captureActive() {
  const t = tabs.find(x => x.id === activeTabId);
  if (!t) return;
  t.doc = doc; t.currentFile = currentFile;
  t.selectedId = selectedId; t.selectedIds = selectedIds.slice();
  t.history = history; t.hi = hi;
  t.batchRows = batchRows; t.batchHeaders = batchHeaders;
}
function activateTab(tab) {
  if (!tab) return;
  captureActive();
  activeTabId = tab.id;
  doc = tab.doc; currentFile = tab.currentFile;
  selectedId = tab.selectedId; selectedIds = (tab.selectedIds || []).slice();
  history = tab.history; hi = tab.hi;
  batchRows = tab.batchRows || []; batchHeaders = tab.batchHeaders || [];
  renderTabBar(); syncDocFields(); renderBatchTable();
  // Fit after the new doc's dimensions are reflected in the layout.
  requestAnimationFrame(() => fitZoom());
  refreshAll(); updateEmptyState();
}
function renderTabBar() {
  const bar = $('#tabList');
  if (!bar) return;
  bar.innerHTML = tabs.map(t => {
    const title = escapeHtml(t.doc && t.doc.name || '未命名标签');
    return `<div class="doc-tab${t.id === activeTabId ? ' active' : ''}" data-tab="${t.id}" title="${title}">` +
      `<svg class="i"><use href="#i-text"/></svg><span class="dt-title">${title}</span>` +
      `<button class="dt-close" data-close="${t.id}" title="关闭标签页">✕</button></div>`;
  }).join('');
  bar.querySelectorAll('.doc-tab').forEach(el => {
    el.onclick = (e) => {
      if (e.target.classList.contains('dt-close')) return;
      const t = tabs.find(x => x.id === el.dataset.tab);
      if (t && t.id !== activeTabId) activateTab(t);
    };
  });
  bar.querySelectorAll('.dt-close').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); closeTab(btn.dataset.close); };
  });
}
function updateEmptyState() {
  const w = $('#welcomeEmpty'); if (!w) return;
  const empty = tabs.length === 0;
  w.hidden = !empty;
  // With no open tab there is no document to show: hide the blank canvas too.
  const wrap = $('#canvasWrap');
  if (wrap) wrap.style.visibility = empty ? 'hidden' : 'visible';
}
if ($('#weOpen')) $('#weOpen').onclick = () => openDocument();
if ($('#weNew')) $('#weNew').onclick = () => newTab();
function newTab() {
  captureActive();
  const t = makeTab();
  tabs.push(t);
  activateTab(t);
  updateEmptyState();
}
function closeTab(id) {
  const idx = tabs.findIndex(x => x.id === id);
  if (idx < 0) return;
  if (tabs.length === 1) {
    // Closing the last tab leaves no document: show welcome, no blank tab.
    captureActive();
    tabs.splice(idx, 1);
    activeTabId = null;
    doc = makeDoc(); currentFile = null; selectedId = null; selectedIds = [];
    history = []; hi = -1;
    batchRows = []; batchHeaders = [];
    renderTabBar(); fitZoom(); refreshAll(); updateEmptyState();
    return;
  }
  if (id === activeTabId) {
    captureActive();
    tabs.splice(idx, 1);
    activateTab(tabs[Math.max(0, idx - 1)]);
  } else {
    tabs.splice(idx, 1);
    renderTabBar();
  }
}
// Open a document in a brand-new tab with a clean undo history.
function openDocInTab(newDoc, file) {
  const d = normalizeDoc(newDoc);
  captureActive();
  const t = makeTab(d, file || null);
  tabs.push(t);
  activateTab(t);
  history = []; hi = -1;
  commit();
  renderTabBar();
}

$('#btnNew').onclick = () => newTab();

function syncDocTab() { renderTabBar(); }

function contentFor(type) {
  // .xtc is the native format: same JSON content, just a different extension.
  return type === 'ddl' ? serializeToDDL(doc) : JSON.stringify(doc, null, 2);
}

$('#btnSave').onclick = async () => {
  if (currentFile && currentFile.path) {
    const r = await api.file.saveTo(currentFile.path, contentFor(currentFile.type));
    if (r.ok) toast('已保存: ' + r.file);
    else toast('保存失败: ' + (r.error || ''));
  } else {
    await saveAsFlow();
  }
};

$('#btnSaveAs').onclick = async () => { await saveAsFlow(); };

async function saveAsFlow() {
  const r = await api.file.saveAs(doc.name || '标签', doc, serializeToDDL(doc), currentFile ? currentFile.type : 'xtc');
  if (!r.ok) return;
  currentFile = { path: r.file, type: r.type };
  const base = String(r.file).split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
  if (base) { doc.name = base; renderTabBar(); }
  toast('已另存为 ' + r.type.toUpperCase() + ': ' + r.file);
}

// "导入" shares the same content-based loader as "打开", so it accepts
// both .ddl and .xtc and records the file path for overwrite-save.
$('#btnImportJson').onclick = () => openDocument();

function applyDoc(newDoc, file) {
  openDocInTab(newDoc, file);
}
function normalizeDoc(d) {
  d = d || {};
  d.width = Number(d.width) || 100;
  d.height = Number(d.height) || 60;
  d.elements = Array.isArray(d.elements) ? d.elements : [];
  d.elements.forEach(e => { if (!e.id) e.id = uid(); });
  return d;
}

/* ---------------- DDL serializer (our doc -> .ddl XML) ----------------
 * Produces a .ddl file in the common XML layout. Reverse of parseDDL below.
 */
function xmlEsc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function attr(k, v) { return ` ${k}="${xmlEsc(v)}"`; }
function serializeToDDL(targetDoc) {
  const d = targetDoc || doc;
  const L = [];
  L.push("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>");
  L.push(`<DLabel source="pc" version="3.2.5" previewimage="">`);
  L.push(` <paper${attr('h', d.height)}${attr('w', d.width)} excelpath="" shapeindex="1" excelid="" excelurl="" veroffset="0" horoffset="0" datasource="" colcount="1" databasefile="" colspacing="2" background=""${attr('printerdpi', d.dpi || 203)} excelhash="" rotate="0" zoomfactor="2.384185791015625" moreselect="true"${attr('bgcolor', d.background || '#ffffff')}>`);
  L.push('  <labelobjects>');
  const els = (d.elements || []).slice().sort((a, b) => (a.zvalue || 0) - (b.zvalue || 0));
  els.forEach((e, idx) => {
    const z = idx + 1;
    const base = `${attr('lock', 'false')}${attr('h', round(e.h))}${attr('l', round(e.x))}${attr('rotate', e.rotation || 0)}${attr('colorflag', '0')}${attr('t', round(e.y))}${attr('w', round(e.w))}${attr('zvalue', z)}`;
    const textSegments = (vals) => `<textlist>${(vals || ['']).map(v => `<text${attr('value', v)} currentdata="1" month="0" addorsub="0" promptname="" hour="0" promptindex="0" year="0" interval="1" second="0" timeformat="0" datasource="0" repeat="1" sharefieldname="" keyinput="0" memory="0" day="0" dateformat="0" minute="0"/>`).join('')}</textlist>`;

    if (e.type === 'text') {
      // Inverse of the import map: 0=left, 2=right, 3=justify, 4=center.
      // "distribute" has no dedicated code here, so it is saved as 3.
      const alignMap = { left: '0', center: '4', right: '2', justify: '3', distribute: '3' };
      const tval = e.dynamic === 'date' ? computeDynamicDate(e) : String(e.text || '');
      L.push(`   <drawobj${base}${attr('fontfamily', e.fontFamily || '微软雅黑')}${attr('fontsize', Math.round((e.fontSize || 5) / 0.35))}${attr('fontbold', !!e.bold)}${attr('fontitalic', !!e.italic)}${attr('fontunderline', !!e.underline)}${attr('fontstrikeout', !!e.strike)}${attr('fontletterspacing', e.letterSpacing || 0)}${attr('alignment', alignMap[e.align] || '4')}${attr('itemtype', '5')}${attr('ellipse', false)}${attr('blackground', !!e.inverse)}${attr('currentdata', '1')}${attr('datasource', '0')}${attr('hormirror', false)}${attr('linespacing', e.lineSpacing || 0)}${attr('stretch', 100)}${attr('textlength', 0)}${attr('startposition', 0)}${attr('interval', 1)}>`);
      L.push('    ' + textSegments(String(tval).split('\n')));
      L.push('   </drawobj>');
      return; // text handled fully here
    } else if (e.type === 'barcode' || e.type === 'qrcode') {
      const isQR = e.type === 'qrcode';
      const bt = isQR ? 'QR_CODE' : (e.format || 'CODE128');
      L.push(`   <drawobj${base}${attr('itemtype', '8')}${attr('barcodetype', bt)}${attr('level', e.ec || 'M')}${attr('datasource', '0')}${attr('currentdata', '1')}${attr('repeat', 1)}${attr('characterset', '0')}${attr('density', '0.5')}${attr('encodemode', 'ANSI')}${attr('addbarcode', false)}${attr('hidelanding', false)}${attr('symbolversion', '3')}>${textSegments([e.value || ''])}</drawobj>`);
    } else if (e.type === 'image') {
      const b64 = (e.src || '').startsWith('data:') ? (e.src.split(',')[1] || '') : '';
      L.push(`   <drawobj${base}${attr('itemtype', '6')}${attr('image', (e.src || '').startsWith('data:') ? '' : (e.src || ''))}${attr('base64', b64)}${attr('embeddocument', b64 ? 'true' : 'false')}${attr('fill', false)}${attr('imgpath', '')}${attr('imgurl', '')}></drawobj>`);
    } else if (e.type === 'rect' || e.type === 'ellipse' || e.type === 'triangle' || e.type === 'blackout') {
      // Shapes: itemtype 2, radius>0 = ellipse. Triangle has no native
      // type here — save as a plain rect (shown as a rectangle).
      L.push(`   <drawobj${base}${attr('itemtype', '2')}${attr('radius', e.type === 'ellipse' ? '1' : '0')}${attr('linetype', '0')}${attr('linewidth', e.strokeWidth || 0.4)}${attr('pattern', '0')}></drawobj>`);
    } else if (e.type === 'line') {
      L.push(`   <drawobj${base}${attr('itemtype', '1')}${attr('linestartx', round(e.x))}${attr('linestarty', round(e.y))}${attr('linelength', round(Math.hypot(e.w, e.h)))}${attr('linedegree', round(Math.atan2(e.h, e.w) * 180 / Math.PI))}${attr('linetype', '0')}${attr('linewidth', e.strokeWidth || 0.4)}></drawobj>`);
    } else if (e.type === 'table') {
      // Emit grid cells with merge spans (crossColumns/crossRows) and real
      // per-column widths so the same layout is preserved on reopen.
      const rows = Math.max(1, e.rows || 1), cols = Math.max(1, e.cols || 1);
      const { xs, ys } = tableEdges(e);
      const merges = tableMerges(e);
      const datas = [];
      for (let r = 0; r < rows; r++) {
        const rowCells = [];
        for (let c = 0; c < cols; c++) {
          const mg = mergeAt(e, r, c);
          const isOrigin = mg && mg.r === r && mg.c === c;
          const cellW = round(xs[c+1] - xs[c]), cellH = round(ys[r+1] - ys[r]);
          const spanned = !!mg && !isOrigin; // covered by an origin cell
          rowCells.push(JSON.stringify({
            alignment: 1, blackGround: false,
            crossColumns: isOrigin ? mg.cs : (spanned ? 0 : 1),
            crossRows: isOrigin ? mg.rs : (spanned ? 0 : 1),
            fontFamily: '微软雅黑', fontSize: 4, fontBold: false, fontItalic: false,
            itemScaleWidth: cellW, itemScaleHeight: cellH,
            itemCombineScaleWidth: isOrigin ? round(xs[c+mg.cs] - xs[c]) : cellW,
            itemCombineScaleHeight: isOrigin ? round(ys[r+mg.rs] - ys[r]) : cellH,
            textList: [{ text: '', sourcetext: '' }]
          }));
        }
        datas.push('{"datas":[' + rowCells.join(',') + ']}');
      }
      L.push(`   <drawobj${base}${attr('itemtype', '12')}${attr('row', rows)}${attr('column', cols)}${attr('tablelinewidth', e.borderWidth || 0.3)}${attr('formDataJson', '[' + datas.join(',') + ']')}></drawobj>`);
    }
  });
  L.push('  </labelobjects>');
  L.push('  <sharedfields><fieldlist/></sharedfields>');
  L.push(' </paper>');
  L.push('</DLabel>');
  return L.join('\r\n');
}

/* ---------------- DDL parser (.ddl XML -> our doc) ---------------- */
// Tolerant by design. Real files differ in encoding (UTF-8 / UTF-16,
// with or without BOM), tag casing and attribute naming. Any of those used to
// make "打开 DDL" fail with a blank canvas while JSON import still worked.
function cleanXmlText(xmlText) {
  let s = String(xmlText == null ? '' : xmlText);
  s = s.replace(/^\uFEFF/, '');                          // UTF-8 BOM
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');   // stray control bytes
  s = s.replace(/^\s+/, '');                             // XML declaration must be first
  s = s.replace(/(<\?xml[^>]*?\bencoding\s*=\s*)(['"])[^'"]*\2/i, "$1'UTF-8'");
  return s;
}
function localName(node) {
  return String(node.localName || node.nodeName || '').replace(/^.*:/, '').toLowerCase();
}
function attrMap(node) {
  const m = {};
  const attrs = node.attributes || [];
  for (let i = 0; i < attrs.length; i++) {
    const a = attrs.item ? attrs.item(i) : attrs[i];
    if (a) m[String(a.name || a.nodeName || '').replace(/^.*:/, '').toLowerCase()] = a.value;
  }
  return m;
}

// Map DLabel's Chinese font names to English family names that Chromium
// reliably renders in a scaled canvas. Bare CJK family names can leave
// fillText blank even though the call succeeds.
function normalizeFontFamily(name) {
  const map = {
    '微软雅黑': 'Microsoft YaHei', '雅黑': 'Microsoft YaHei',
    '黑体': 'SimHei', '宋体': 'SimSun', '仿宋': 'FangSong',
    '楷体': 'KaiTi', '隶书': 'LiSu', '幼圆': 'YouYuan',
    '华文细黑': 'STXihei', '华文楷体': 'STKaiti', '华文宋体': 'STSong'
  };
  const fam = String(name || 'Microsoft YaHei').split(',')[0].trim().replace(/^["']|["']$/g, '');
  return map[fam] || fam || 'Microsoft YaHei';
}

function parseDDL(xmlText) {
  const raw = cleanXmlText(xmlText);
  if (!raw) throw new Error('文件内容为空');
  const xml = new DOMParser().parseFromString(raw, 'text/xml');
  const err = xml.getElementsByTagName('parsererror');
  if (err.length) throw new Error('XML 解析失败：' + String(err[0].textContent || '').trim().slice(0, 100));
  if (!xml.documentElement) throw new Error('XML 内容为空');

  const num = (v, d = 0) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
  const all = Array.from(xml.getElementsByTagName('*'));
  const paper = all.find(n => localName(n) === 'paper');
  const out = makeDoc();
  out.name = '标签导入';
  if (paper) {
    const p = attrMap(paper);
    const pw = p.w != null ? p.w : (p.width != null ? p.width : p.paperwidth);
    const ph = p.h != null ? p.h : (p.height != null ? p.height : p.paperheight);
    out.width = Math.min(500, Math.max(10, num(pw, 100)));
    out.height = Math.min(500, Math.max(10, num(ph, 60)));
    out.dpi = num(p.printerdpi, 203) || 203;
    if (p.bgcolor) out.background = p.bgcolor;
  }

  // Match object nodes case-insensitively; some versions use other tags.
  const OBJ_TAGS = ['drawobj', 'drawobject', 'labelobject', 'object', 'obj', 'item', 'element'];
  const objs = all.filter(n => OBJ_TAGS.indexOf(localName(n)) !== -1);
  const textValues = (node) => {
    const arr = [];
    Array.from(node.getElementsByTagName('*')).forEach(k => {
      if (localName(k) === 'text') {
        const m = attrMap(k);
        const v = m.value != null ? m.value : (m.text != null ? m.text : (m.sourcetext != null ? m.sourcetext : k.textContent));
        arr.push(String(v == null ? '' : v));
      }
    });
    if (!arr.length) {
      const m = attrMap(node);
      const v = m.value != null ? m.value : (m.text != null ? m.text : m.sourcetext);
      if (v) arr.push(String(v));
    }
    return arr;
  };

  objs.forEach(obj => {
    const m = attrMap(obj);
    const g = (...names) => {
      for (const n of names) { const k = String(n).toLowerCase(); if (m[k] != null && m[k] !== '') return m[k]; }
      return null;
    };
    const it = g('itemtype', 'type', 'objtype');
    const x = num(g('l', 'left', 'x')), y = num(g('t', 'top', 'y'));
    const w = num(g('w', 'width')), h = num(g('h', 'height'));
    const common = {
      id: uid(), x: round(x), y: round(y),
      w: round(Math.abs(w) || 10), h: round(Math.abs(h) || 5),
      rotation: num(g('rotate', 'rotation')), zvalue: num(m.zvalue, 0)
    };
    const vals = textValues(obj);
    // DLabel stores line width in mm directly; no /10 scaling.
    const lineW = Math.max(0.1, num(g('linewidth', 'tablelinewidth'), 0.3));

    if (it === '5' || (it == null && vals.length)) {
      // Alignment codes seen in real files (0..4). 1 and 4 both render
      // centered in common versions; 3 is the rare "justify" value.
      const alignMap = { '0': 'left', '1': 'center', '4': 'center', '2': 'right', '3': 'justify' };
      out.elements.push(Object.assign(common, {
        type: 'text', name: (vals[0] || '文本').slice(0, 12),
        // Normalize Chinese font aliases to their English family names:
        // Chromium can silently skip fillText with a bare CJK family name in
        // a scaled canvas context. "微软雅黑" -> "Microsoft YaHei", etc.
        text: vals.join(''), fontFamily: normalizeFontFamily(m.fontfamily),
        fontSize: round(Math.max(2, num(m.fontsize, 10) * 0.35)),
        bold: m.fontbold === 'true', italic: m.fontitalic === 'true',
        underline: m.fontunderline === 'true', strike: m.fontstrikeout === 'true',
        color: '#111111', align: alignMap[m.alignment] || 'left'
      }));
    } else if (it === '8') {
      const bt = String(m.barcodetype || 'CODE128').toUpperCase();
      if (bt.indexOf('QR') !== -1 || bt.indexOf('MATRIX') !== -1) {
        out.elements.push(Object.assign(common, { type: 'qrcode', name: '二维码', value: vals.join(''), ec: m.level || 'M' }));
      } else {
        const fmtMap = { EAN13: 'EAN13', EAN8: 'EAN8', UPC: 'UPC', CODE39: 'CODE39', ITF: 'ITF', ITF14: 'ITF', CODABAR: 'CODABAR' };
        out.elements.push(Object.assign(common, { type: 'barcode', name: '一维码', value: vals.join(''), format: fmtMap[bt] || 'CODE128', displayValue: true, lineColor: '#111111' }));
      }
    } else if (it === '1') {
      const sx = num(m.linestartx != null ? m.linestartx : x);
      const sy = num(m.linestarty != null ? m.linestarty : y);
      const deg = num(m.linedegree, 0) * Math.PI / 180;
      const len = num(m.linelength, Math.max(Math.abs(w), Math.abs(h)));
      let lw = len * Math.cos(deg), lh = len * Math.sin(deg);
      // Snap imported lines to horizontal/vertical as well, so no line is ever slanted.
      if (Math.abs(lw) >= Math.abs(lh)) lh = 0; else lw = 0;
      out.elements.push(Object.assign(common, {
        type: 'line', name: '线条', x: round(sx), y: round(sy),
        w: round(lw), h: round(lh),
        stroke: '#111111', strokeWidth: lineW
      }));
    } else if (it === '2') {
      const isEllipse = num(m.radius, 0) > 0;
      // DLabel colorflag=0 means no fill (outline only). A filled shape with
      // a high zvalue would cover text underneath it, which is the reason
      // some imported labels appeared to have all their text missing.
      const hasFill = m.colorflag == null ? true : num(m.colorflag, 0) > 0;
      out.elements.push(Object.assign(common, {
        type: isEllipse ? 'ellipse' : 'rect', name: isEllipse ? '椭圆' : '矩形',
        fill: hasFill ? '#ffffff' : 'transparent', stroke: '#111111', strokeWidth: lineW, radius: 0
      }));
    } else if (it === '6') {
      const b64 = m.base64 || '';
      out.elements.push(Object.assign(common, {
        type: 'image', name: '图片', grayscale: false, opacity: 1,
        src: b64 ? 'data:image/png;base64,' + b64 : (m.image || m.imgpath || '')
      }));
    } else if (it === '12') {
      const rows = Math.max(1, Math.round(num(m.row, 1)));
      const cols = Math.max(1, Math.round(num(m.column, 1)));
      const cells = [];
      for (let r = 0; r < rows; r++) cells.push(new Array(cols).fill(''));
      let colW = null, rowH = null, merges = [];
      const fj = m.formdatajson;
      if (fj) {
        try {
          const parsed = JSON.parse(fj);
          if (Array.isArray(parsed)) {
            // Derive per-column widths and per-row heights from real cell sizes
            // (tables are usually NOT evenly spaced). This fixes the
            // "table deformed" issue on import.
            const cw = new Array(cols).fill(0), rh = new Array(rows).fill(0);
            parsed.slice(0, rows).forEach((rowObj, r) => {
              const datas = (rowObj && rowObj.datas) || [];
              datas.slice(0, cols).forEach((cellData, c) => {
                const tl = (cellData && cellData.textList) || [];
                cells[r][c] = tl.map(t => t.text != null ? t.text : (t.sourcetext != null ? t.sourcetext : (t.currentdata || ''))).join('');
                const cc = Math.max(1, Math.round(num(cellData && cellData.crossColumns, 1)) || 1);
                const crr = Math.max(1, Math.round(num(cellData && cellData.crossRows, 1)) || 1);
                const sw = num(cellData && cellData.itemScaleWidth, 0);
                const sh = num((cellData && (cellData.itemCombineScaleHeight || cellData.itemScaleHeight)), 0);
                // attribute width/height to the columns/rows this cell spans
                for (let k = 0; k < cc && c + k < cols; k++) cw[c + k] = Math.max(cw[c + k], sw / cc);
                for (let k = 0; k < crr && r + k < rows; k++) rh[r + k] = Math.max(rh[r + k], sh / crr);
                if (cc > 1 || crr > 1) merges.push({ r, c, rs: crr, cs: cc });
              });
            });
            const sumW = cw.reduce((a, b) => a + b, 0), sumH = rh.reduce((a, b) => a + b, 0);
            colW = sumW > 0 ? cw.map(w => (w > 0 ? w : 1)) : null;
            rowH = sumH > 0 ? rh.map(h => (h > 0 ? h : 1)) : null;
            // de-duplicate merges (spanned cells repeat data)
            const seen = new Set();
            merges = merges.filter(m => { const k = m.r + ',' + m.c + ',' + m.rs + ',' + m.cs; if (seen.has(k)) return false; seen.add(k); return true; });
          }
        } catch (e) {}
      }
      out.elements.push(Object.assign(common, {
        type: 'table', name: '表格', rows, cols, cells,
        colRatios: colW || new Array(cols).fill(1), rowRatios: rowH || new Array(rows).fill(1),
        merges,
        borderWidth: Math.max(0.1, num(m.tablelinewidth, 0.3)),
        borderColor: '#111111', cellFill: '#ffffff',
        fontFamily: 'Microsoft YaHei', fontSize: 3.5, color: '#111111', align: 'center'
      }));
    } else {
      // Keep unknown objects visible instead of silently producing a blank page.
      out.elements.push(Object.assign(common, {
        type: 'text', name: '未识别对象',
        text: vals.length ? vals.join('') : ('[' + (it || localName(obj)) + ']'),
        fontFamily: 'Microsoft YaHei', fontSize: 3, color: '#888888', align: 'left'
      }));
    }
  });

  out.elements.sort((a, b) => (a.zvalue || 0) - (b.zvalue || 0));
  return out;
}

// One content-based loader shared by BOTH "打开" and "导入": accepts .ddl
// XML and our JSON, so the two buttons can never diverge again.
function loadDocumentText(text, filePath) {
  const s = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/^\s+/, '');
  if (!s) throw new Error('文件内容为空');
  if (s.charAt(0) === '{' || s.charAt(0) === '[') {
    const j = JSON.parse(s);
    const d = Array.isArray(j) ? j[0] : j;
    if (!d || typeof d !== 'object' || !Array.isArray(d.elements)) throw new Error('不是有效的标签文档');
    return { doc: normalizeDoc(d), type: 'xtc' };
  }
  return { doc: parseDDL(s), type: 'ddl' };
}

function loadFromOpenResult(r) {
  if (!r || !r.ok) { if (r && r.error) toast('打开失败：' + r.error); return; }
  try {
    const res = loadDocumentText(r.text != null ? r.text : r.xml, r.path);
    // Use the real file name (without extension) as the document title instead
    // of the generic ".ddl import" placeholder set by parseDDL.
    const base = String(r.path || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    if (base) res.doc.name = base;
    applyDoc(res.doc, { path: r.path, type: res.type });
    const n = res.doc.elements.length;
    const name = String(r.path || '').split(/[\\/]/).pop();
    if (n) toast('已打开 ' + name + '：' + n + ' 个元素（' + res.doc.width + '×' + res.doc.height + 'mm）');
    else toast('文件已打开，但未识别到可编辑元素（' + res.doc.width + '×' + res.doc.height + 'mm）');
  } catch (e) {
    toast('打开失败：' + e.message);
    const ci = $('#cursorInfo'); if (ci) ci.textContent = '打开失败：' + e.message;
    console.error('[open]', e);
  }
}

async function openDocument() {
  let r = null;
  try {
    if (api && api.file && api.file.openAny) r = await api.file.openAny();
    else if (api && api.ddl && api.ddl.open) {
      const d = await api.ddl.open();
      if (d) r = Object.assign({}, d, { text: d.text != null ? d.text : d.xml });
    }
  } catch (e) { toast('打开失败：' + e.message); return; }
  loadFromOpenResult(r);
}

$('#btnOpenDdl').onclick = () => openDocument();

// Double-clicked .ddl / .xtc (file association) -> main sends the path here.
if (api && api.onOpenPath) {
  api.onOpenPath(async (filePath) => {
    if (!filePath) return;
    try {
      const r = await api.file.read(filePath);
      loadFromOpenResult(r);
    } catch (e) { toast('打开失败：' + e.message); }
  });
  // Tell the main process our listener is installed; it can now deliver any
  // file path that came from a cold-start double-click (file association).
  if (api.rendererReady) api.rendererReady();
}

function bindDragOpen() {
  const prevent = (e) => { if (e && e.preventDefault) { e.preventDefault(); e.stopPropagation(); } };
  document.addEventListener('dragenter', prevent, false);
  document.addEventListener('dragover', (e) => { prevent(e); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; }, false);
  document.addEventListener('drop', async (e) => {
    prevent(e);
    const files = e.dataTransfer && e.dataTransfer.files;
    if (!files || !files.length) return;
    const p = files[0].path;
    if (!p) { toast('无法读取拖入文件路径，请使用「打开」按钮'); return; }
    if (!/\.(ddl|xtc)$/i.test(p)) { toast('只支持 .xtc 和 .ddl 文件'); return; }
    try { loadFromOpenResult(await api.file.read(p)); }
    catch (err) { toast('打开失败：' + err.message); }
  }, false);
}
bindDragOpen();

/* ---------------- data import ---------------- */
async function importData() {
  const r = await api.data.open();
  if (!r.ok) return;
  try {
    let wb;
    const ext = r.path.split('.').pop().toLowerCase();
    if (ext === 'csv' || ext === 'txt') {
      const fs = require('fs');
      let text = fs.readFileSync(r.path, 'utf8');
      if (ext === 'txt') {
        // try common delimiters
        const delim = text.includes('\t') ? '\t' : (text.includes(',') ? ',' : '|');
        wb = XLSX.read(text, { type: 'string', raw: false, FS: delim });
      } else {
        wb = XLSX.read(text, { type: 'string' });
      }
    } else {
      wb = XLSX.readFile(r.path);
    }
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
    if (!rows.length) { toast('文件中没有数据'); return; }
    batchHeaders = Object.keys(rows[0]);
    batchRows = rows;
    $('#btnBatchOpen').textContent = '📊 ' + r.path.split(/[\\/]/).pop();
    renderBatchTable();
    expandBatch();
    toast('已导入 ' + rows.length + ' 条记录');
  } catch (e) {
    toast('解析失败: ' + e.message);
  }
}
function renderBatchTable() {
  const table = $('#batchTable');
  const thead = table.querySelector('thead'), tbody = table.querySelector('tbody');
  thead.innerHTML = '<tr>' + batchHeaders.map(h => `<th>${escapeHtml(h)}</th>`).join('') + '</tr>';
  tbody.innerHTML = '';
  batchRows.slice(0, 100).forEach(row => {
    const tr = document.createElement('tr');
    tr.innerHTML = batchHeaders.map(h => `<td>${escapeHtml(row[h])}</td>`).join('');
    tbody.appendChild(tr);
  });
  $('#batchCount').textContent = batchRows.length + ' 条记录' + (batchRows.length > 100 ? ' (显示前100)' : '');
  if ($('#statusDb')) $('#statusDb').textContent = '数据库：' + batchRows.length + ' 条';
}
$('#btnImportData').onclick = importData;
$('#btnBatchOpen').onclick = importData;
$('#btnBatchClear').onclick = () => {
  batchRows = []; batchHeaders = [];
  $('#batchTable').querySelector('thead').innerHTML = '';
  $('#batchTable').querySelector('tbody').innerHTML = '';
  $('#batchCount').textContent = '0 条记录';
  if ($('#statusDb')) $('#statusDb').textContent = '数据库：0 条';
  $('#btnBatchOpen').textContent = '导入数据文件';
  $('#batchEnabled').checked = false;
};

function buildRecords() {
  const enabled = $('#batchEnabled').checked;
  const serialOn = $('#useSerial').checked;
  const dateOn = $('#useDate').checked;
  const start = parseFloat($('#serialStart').value) || 0;
  const step = parseFloat($('#serialStep').value) || 1;
  const pad = parseInt($('#serialPad').value) || 0;
  const today = formatDate($('#dateFormat').value || 'YYYY-MM-DD');
  if (!enabled && !serialOn && !dateOn) return [null];
  const count = enabled && batchRows.length ? batchRows.length : 1;
  const records = [];
  for (let i = 0; i < count; i++) {
    const base = enabled && batchRows[i] ? Object.assign({}, batchRows[i]) : {};
    if (serialOn) {
      let s = String(start + i * step);
      base.__serial = pad ? s.padStart(pad, '0') : s;
    } else base.__serial = '';
    base.__date = dateOn ? today : '';
    records.push(base);
  }
  return records;
}
function formatDate(fmt) {
  const d = new Date();
  const map = {
    YYYY: d.getFullYear(), MM: String(d.getMonth() + 1).padStart(2, '0'), DD: String(d.getDate()).padStart(2, '0'),
    HH: String(d.getHours()).padStart(2, '0'), mm: String(d.getMinutes()).padStart(2, '0'), SS: String(d.getSeconds()).padStart(2, '0')
  };
  return String(fmt).replace(/YYYY|MM|DD|HH|mm|SS/g, k => map[k]);
}

/* ---------------- render to offscreen (for export/print) ---------------- */
function renderToCanvas(record, dpi) {
  const scale = dpi / MM;
  const c = document.createElement('canvas');
  c.width = Math.round(doc.width * scale);
  c.height = Math.round(doc.height * scale);
  const cc = c.getContext('2d');
  render(cc, doc, scale, { forExport: true, record, batchEnabled: !!record });
  return c;
}

$('#btnExportPng').onclick = () => {
  const records = buildRecords();
  if (records.length === 1 || !records[0]) {
    const c = renderToCanvas(null, 300);
    api.exportFile.png(doc.name || '标签', c.toDataURL('image/png')).then(r => { if (r.ok) toast('PNG 已导出: ' + r.file); });
  } else {
    // export first record only for single PNG; tell user to use PDF for batch
    toast('批量数据请用「PDF」或「打印」导出多张；PNG 导出当前模板首张。');
    const c = renderToCanvas(records[0], 300);
    api.exportFile.png(doc.name || '标签', c.toDataURL('image/png')).then(r => { if (r.ok) toast('PNG 已导出: ' + r.file); });
  }
};

$('#btnExportPdf').onclick = () => {
  const records = buildRecords();
  const pdf = new jsPDF({ unit: 'mm', format: [doc.width, doc.height], orientation: doc.width >= doc.height ? 'landscape' : 'portrait' });
  records.forEach((rec, i) => {
    if (i > 0) pdf.addPage([doc.width, doc.height], doc.width >= doc.height ? 'landscape' : 'portrait');
    const c = renderToCanvas(rec, 300);
    pdf.addImage(c.toDataURL('image/png'), 'PNG', 0, 0, doc.width, doc.height);
  });
  const base64 = pdf.output('datauristring').split(',')[1];
  api.exportFile.pdf(doc.name || '标签', base64).then(r => { if (r.ok) toast('PDF 已导出 (' + records.length + ' 页): ' + r.file); });
};

/* ================= 203DPI 1-bit rendering & print center =================
 * TSPL BITMAP data: 8 dots per byte, MSB first.
 * We use bit=1 -> WHITE (unprinted), bit=0 -> BLACK (printed) — the common
 * TSPL/Xprinter convention. The preview shows exactly the same bits that are
 * sent, and invert/mirror/rotate are applied to that single buffer so what
 * you see is what the printer receives.
 */
const PRINT_DPI = 203;

function bufToBase64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  return btoa(s);
}

// Render label -> grayscale -> packed 1-bit. bit 0 = black, bit 1 = white.
// IMPORTANT: the design (doc.width x doc.height mm) is scaled to fit the actual
// paper (widthMm x heightMm). This prevents a 100x70 design fed to a 50x40
// printer from splitting into 4 physical labels — it stays exactly 1 label.
function renderTo1Bit(record, widthMm, heightMm, corrections) {
  const DPI = PRINT_DPI;
  const wpx = Math.round(widthMm * DPI / 25.4);
  const hpx = Math.round(heightMm * DPI / 25.4);
  const c = document.createElement('canvas');
  c.width = wpx; c.height = hpx;
  const cc = c.getContext('2d', { willReadFrequently: true });
  cc.fillStyle = '#ffffff'; cc.fillRect(0, 0, wpx, hpx);

  const sx = widthMm / doc.width, sy = heightMm / doc.height;
  if (Math.abs(sx - 1) < 0.001 && Math.abs(sy - 1) < 0.001) {
    // same size: render directly
    render(cc, doc, DPI / 25.4, { forExport: true, record, batchEnabled: !!record });
  } else {
    // render design at its own size, then scale into the paper bitmap
    const dw = Math.max(1, Math.round(doc.width * DPI / 25.4));
    const dh = Math.max(1, Math.round(doc.height * DPI / 25.4));
    const tmp = document.createElement('canvas');
    tmp.width = dw; tmp.height = dh;
    const tc = tmp.getContext('2d');
    tc.fillStyle = '#ffffff'; tc.fillRect(0, 0, dw, dh);
    render(tc, doc, DPI / 25.4, { forExport: true, record, batchEnabled: !!record });
    cc.imageSmoothingEnabled = true;
    cc.drawImage(tmp, 0, 0, dw, dh, 0, 0, wpx, hpx);
  }
  const img = cc.getImageData(0, 0, wpx, hpx).data;
  const widthBytes = Math.ceil(wpx / 8);
  const buf = new Uint8Array(widthBytes * hpx);
  buf.fill(0xff); // all white by default (bit 1 = white)
  const threshold = 168;
  for (let y = 0; y < hpx; y++) {
    for (let x = 0; x < wpx; x++) {
      const p = (y * wpx + x) * 4;
      const lum = 0.299 * img[p] + 0.587 * img[p + 1] + 0.114 * img[p + 2];
      if (lum < threshold) {
        const bytePos = y * widthBytes + (x >> 3);
        const bitPos = 7 - (x & 7);
        buf[bytePos] &= ~(1 << bitPos); // clear bit -> black
      }
    }
  }
  // padding bits (beyond wpx) must stay white
  const padBits = widthBytes * 8 - wpx;
  if (padBits > 0) {
    const mask = (0xff << padBits) & 0xff;
    for (let y = 0; y < hpx; y++) buf[y * widthBytes + widthBytes - 1] |= (~mask & 0xff);
  }
  let result = { widthBytes, height: hpx, data: buf };
  if (corrections) result = applyCorrections(result, corrections);
  return result;
}

// Apply invert / mirror / 180-rotation to the packed buffer in place-ish.
function applyCorrections(bm, opts) {
  const { widthBytes, height } = bm;
  let data = new Uint8Array(bm.data);
  if (opts.invert) {
    for (let i = 0; i < data.length; i++) data[i] = ~data[i] & 0xff;
  }
  if (opts.mirror) {
    const out = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) {
      const row = y * widthBytes;
      for (let b = 0; b < widthBytes; b++) out[row + b] = reverseByte(data[row + widthBytes - 1 - b]);
    }
    data = out;
  }
  if (opts.rotate === 180) {
    const out = new Uint8Array(data.length);
    for (let y = 0; y < height; y++) {
      for (let b = 0; b < widthBytes; b++) {
        out[y * widthBytes + b] = reverseByte(data[(height - 1 - y) * widthBytes + widthBytes - 1 - b]);
      }
    }
    data = out;
  }
  return { widthBytes, height, data };
}
function reverseByte(v) {
  let r = 0;
  for (let i = 0; i < 8; i++) { r = (r << 1) | (v & 1); v >>= 1; }
  return r & 0xff;
}

// Print-center preview: high-resolution VECTOR render of the document scaled
// into the paper. The old preview drew the 203-DPI 1-bit print buffer enlarged
// with imageSmoothingEnabled=false, so text looked jagged/blurry. Rendering the
// actual document with anti-aliasing keeps text sharp while still showing the
// exact paper size and scale that will be printed.
let pcZoom = 2;
let pcCurrentBm = null;      // still built for printing; kept for compatibility
let pcPreviewPaper = null;   // { widthMm, heightMm }
let pcPreviewRecord = null;
function drawPrintPreview(bm, paper, record) {
  const canvas = $('#pcCanvas');
  if (!bm) return;
  pcCurrentBm = bm; window.pcCurrentBm = bm;
  const paperW = (paper && paper.widthMm) || doc.width;
  const paperH = (paper && paper.heightMm) || doc.height;
  pcPreviewPaper = { widthMm: paperW, heightMm: paperH };
  pcPreviewRecord = record || null;

  // Render at a dense, fixed resolution for crisp text, then let CSS/zoom
  // display it. pxPerMm is independent of the 1-bit print raster.
  const renderPpi = 300;                       // vector render resolution
  const pxPerMm = renderPpi / 25.4;            // ~11.8 px/mm
  const wpx = Math.max(1, Math.round(paperW * pxPerMm));
  const hpx = Math.max(1, Math.round(paperH * pxPerMm));
  canvas.width = wpx; canvas.height = hpx;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, wpx, hpx);

  // Apply print corrections (mirror / 180° / invert) around the paper center.
  const corr = printCorrections();
  ctx.save();
  if (corr.rotate === 180) { ctx.translate(wpx, hpx); ctx.rotate(Math.PI); }
  if (corr.mirror) { ctx.translate(wpx, 0); ctx.scale(-1, 1); }

  const rec = pcPreviewRecord;
  const batchOn = !!(rec);
  if (Math.abs(paperW - doc.width) < 0.01 && Math.abs(paperH - doc.height) < 0.01) {
    render(ctx, doc, pxPerMm, { forExport: true, record: rec, batchEnabled: batchOn });
  } else {
    // Render design at its own size, then scale into the paper rect (same as
    // renderTo1Bit) so a 100×70 design shrinks to fit a 50×40 paper as 1 label.
    const dw = Math.max(1, Math.round(doc.width * pxPerMm));
    const dh = Math.max(1, Math.round(doc.height * pxPerMm));
    const tmp = document.createElement('canvas');
    tmp.width = dw; tmp.height = dh;
    const tc = tmp.getContext('2d');
    tc.fillStyle = '#ffffff'; tc.fillRect(0, 0, dw, dh);
    render(tc, doc, pxPerMm, { forExport: true, record: rec, batchEnabled: batchOn });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, dw, dh, 0, 0, wpx, hpx);
  }
  ctx.restore();

  if (corr.invert) {
    ctx.save();
    ctx.globalCompositeOperation = 'difference';
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, wpx, hpx);
    ctx.restore();
  }
  applyPreviewZoom();
  $('#pcPreviewInfo').textContent = `矢量预览 · ${paperW}×${paperH}mm · @${renderPpi}DPI`;
}
// Display size of the preview. Canvas stays at high fixed resolution; only
// CSS size changes, so text remains crisp at every zoom level.
function applyPreviewZoom() {
  const canvas = $('#pcCanvas'); if (!canvas) return;
  const base = 3.0; // css px per mm at 100%
  const w = (pcPreviewPaper ? pcPreviewPaper.widthMm : canvas.width / (300/25.4)) * base * pcZoom;
  canvas.style.width = Math.round(w) + 'px';
  canvas.style.height = 'auto';
  $('#pcZoomLabel').textContent = Math.round(pcZoom * 100) + '%';
}

function printCorrections() {
  return { invert: $('#printInvert').checked, mirror: $('#printMirror').checked, rotate: parseInt($('#printRotate').value) || 0 };
}
function printPaper() {
  const useDoc = $('#printSyncPaper').checked;
  return {
    widthMm: useDoc ? doc.width : (parseFloat($('#printGapW').value) || 50),
    heightMm: useDoc ? doc.height : (parseFloat($('#printGapH').value) || 40),
    gapMm: Math.max(0, parseFloat($('#printGap').value) || 0)
  };
}
function refreshPrintPreview() {
  const records = buildRecords();
  const rec = records && records[0] ? records[0] : null;
  const paper = printPaper();
  const bm = renderTo1Bit(rec, paper.widthMm, paper.heightMm, printCorrections());
  drawPrintPreview(bm, paper, rec);
  const n = (records.length === 1 && !records[0]) ? 1 : records.length;
  const copies = Math.max(1, parseInt($('#printCopies').value) || 1);
  $('#pcJobInfo').textContent = `${n} 张标签 × ${copies} 份 = ${n * copies} 张`;
  if ($('#pcPageInfo')) $('#pcPageInfo').textContent = `标签 1 / ${n} · 共 ${n * copies} 张`;
  updatePaperHint();
}

/* ---------------- printer list ---------------- */
let printersLoaded = false;
async function refreshPrinters() {
  const sel = $('#printerSelect');
  if (!api || !api.print || !api.print.printers) return;
  try {
    const r = await api.print.printers();
    sel.innerHTML = '';
    const none = document.createElement('option'); none.value = ''; none.textContent = '（未选择）'; sel.appendChild(none);
    if (r.ok && r.printers.length) {
      r.printers.forEach(p => {
        const o = document.createElement('option');
        o.value = p.name;
        o.textContent = p.displayName + (p.isDefault ? ' (默认)' : '');
        sel.appendChild(o);
      });
      const thermal = r.printers.find(p => /50X40|100X70|QR-588|LABEL/i.test(p.name + p.displayName));
      if (thermal) sel.value = thermal.name;
      printersLoaded = true;
    }
  } catch (e) { sel.innerHTML = '<option value="">无法读取打印机</option>'; }
}

/* ---------------- print center modal ---------------- */
function printerPaper(name) {
  const m = String(name || '').match(/(\d+)\s*[xX×]\s*(\d+)/);
  if (m) return { w: parseInt(m[1]), h: parseInt(m[2]) };
  return { w: 50, h: 40 };
}
function syncPaperFromPrinter() {
  if ($('#printSyncPaper').checked) return;
  const p = printerPaper($('#printerSelect').value);
  $('#printGapW').value = p.w; $('#printGapH').value = p.h;
  updatePaperHint();
}
function updatePaperHint() {
  const hint = $('#paperHint'); if (!hint) return;
  const paper = printPaper();
  updatePaperTag();
  if ($('#printSyncPaper').checked) {
    hint.style.color = '#c9772a';
    hint.textContent = '⚠ 用画布尺寸：若画布(' + doc.width + '×' + doc.height + ')大于纸张，会切成多张！';
  } else {
    hint.style.color = '#2aa17a';
    hint.textContent = '✓ 按纸张 ' + paper.widthMm + '×' + paper.heightMm + 'mm 出图，画布内容自动缩放为 1 张。';
  }
}
function fitPrintPreview() {
  const wrap = $('#pcCanvasWrap');
  if (!pcPreviewPaper || !wrap) return;
  const base = 3.0;
  const zx = (wrap.clientWidth - 56) / (pcPreviewPaper.widthMm * base);
  const zy = (wrap.clientHeight - 56) / (pcPreviewPaper.heightMm * base);
  pcZoom = Math.max(0.25, Math.min(8, Math.min(zx, zy)));
  applyPreviewZoom();
}
function openPrintCenter() {
  $('#printModal').hidden = false;
  if (!printersLoaded) refreshPrinters();
  syncPaperFromPrinter();
  refreshPrintPreview();
  updatePaperHint();
  requestAnimationFrame(fitPrintPreview); // auto-fit so preview never overflows
}
function closePrintCenter() { $('#printModal').hidden = true; }
$('#btnPrint').onclick = openPrintCenter;
$('#btnClosePrint').onclick = closePrintCenter;
$('#btnPcCancel').onclick = closePrintCenter;
$('#printModal').addEventListener('click', (e) => { if (e.target.id === 'printModal') closePrintCenter(); });
$('#btnRefreshPrinters').onclick = refreshPrinters;
$('#pcZoomIn').onclick = () => { pcZoom = Math.min(8, pcZoom + 0.25); applyPreviewZoom(); };
$('#pcZoomOut').onclick = () => { pcZoom = Math.max(0.25, pcZoom - 0.25); applyPreviewZoom(); };
$('#pcZoomFit').onclick = () => {
  const wrap = $('#pcCanvasWrap');
  if (!pcPreviewPaper || !wrap) return;
  const base = 3.0;
  const zx = (wrap.clientWidth - 56) / (pcPreviewPaper.widthMm * base);
  const zy = (wrap.clientHeight - 56) / (pcPreviewPaper.heightMm * base);
  pcZoom = Math.max(0.25, Math.min(8, Math.min(zx, zy)));
  applyPreviewZoom();
};
['printInvert', 'printMirror', 'printRotate', 'printGap', 'printCopies', 'printDensity', 'printGapW', 'printGapH', 'pcShowGrid'].forEach(id => {
  const el = $('#' + id);
  if (el) { el.addEventListener('change', refreshPrintPreview); el.addEventListener('input', refreshPrintPreview); }
});
if ($('#printSyncPaper')) $('#printSyncPaper').addEventListener('change', () => {
  syncPaperFromPrinter(); refreshPrintPreview(); updatePaperHint();
});
if ($('#printerSelect')) $('#printerSelect').addEventListener('change', () => {
  syncPaperFromPrinter(); refreshPrintPreview(); updatePaperHint();
});

async function doRawPrint(testPage) {
  const printerName = $('#printerSelect').value;
  if (!printerName) { toast('请先选择标签打印机'); return; }
  const paper = printPaper();
  const copies = Math.max(1, parseInt($('#printCopies').value) || 1);
  const density = Math.max(0, Math.min(15, parseInt($('#printDensity').value) || 8));
  const corr = printCorrections();
  const records = testPage ? [null] : buildRecords();
  toast('正在生成位图…');
  try {
    const bitmaps = records.map(rec => {
      const bm = renderTo1Bit(rec, paper.widthMm, paper.heightMm, corr);
      return [{ x: 0, y: 0, widthBytes: bm.widthBytes, height: bm.height, data: bufToBase64(bm.data) }];
    });
    const paperMode = $('#printPaperMode') ? $('#printPaperMode').value : 'gap';
    const offsetDot = $('#printOffset') ? (parseInt($('#printOffset').value) || 0) : 0;
    const r = await api.print.raw({
      printerName, widthMm: paper.widthMm, heightMm: paper.heightMm, gapMm: paper.gapMm,
      density, copies: testPage ? 1 : copies, dark: false, bitmaps, paperMode, offsetDot,
      calibrate: testPage && paperMode === 'detect'
    });
    if (r.ok) toast((testPage ? '测试页' : '打印') + '已发送到 ' + printerName + ' (' + bitmaps.length + ' 张)');
    else toast('打印失败' + (r.error ? ': ' + r.error : ''));
  } catch (e) { toast('打印失败: ' + e.message); }
}
$('#btnPcPrint').onclick = () => doRawPrint(false);
$('#btnPcTest').onclick = () => doRawPrint(true);

/* ---------------- print-center polish ---------------- */
if ($('#copiesMinus')) $('#copiesMinus').onclick = () => {
  const el = $('#printCopies'); el.value = Math.max(1, (parseInt(el.value) || 1) - 1);
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
if ($('#copiesPlus')) $('#copiesPlus').onclick = () => {
  const el = $('#printCopies'); el.value = Math.max(1, (parseInt(el.value) || 1) + 1);
  el.dispatchEvent(new Event('change', { bubbles: true }));
};
function updatePaperTag() {
  const tag = $('#paperSizeTag'); if (!tag) return;
  const w = $('#printGapW') ? $('#printGapW').value : 50;
  const h = $('#printGapH') ? $('#printGapH').value : 40;
  tag.textContent = w + ' × ' + h + ' mm';
}

/* ---------------- window controls ---------------- */
if ($('#winMin')) $('#winMin').onclick = () => { if (api && api.win) api.win.minimize(); };
if ($('#winMax')) $('#winMax').onclick = () => { if (api && api.win) api.win.maximize(); };
if ($('#winClose')) $('#winClose').onclick = () => { if (api && api.win) api.win.close(); };

/* ---------------- init ---------------- */
// Check GitHub for a newer release and show a non-blocking banner if found.
// Runs silently offline; failures are ignored on purpose.
function checkForUpdate() {
  if (!api || !api.app || !api.app.checkUpdate) return;
  api.app.checkUpdate().then(r => {
    if (!r || !r.update) return;
    const box = $('#updateToast');
    const txt = $('#updateText');
    if (!box || !txt) return;
    txt.textContent = `发现新版本 v${r.version}（当前 v${r.current}），点击下载`;
    box.dataset.url = r.url || '';
    box.hidden = false;
  }).catch(() => {});
}
function bindUpdateToast() {
  const box = $('#updateToast');
  if (!box) return;
  const openBtn = $('#updateOpen'), closeBtn = $('#updateClose');
  if (openBtn) openBtn.onclick = () => {
    const url = box.dataset.url;
    if (url && api && api.app && api.app.openExternal) api.app.openExternal(url);
    else if (url) window.open(url, '_blank');
    box.hidden = true;
  };
  if (closeBtn) closeBtn.onclick = () => { box.hidden = true; };
}

/* ---------------- new label dialog ---------------- */
function updateNewLabelPreview() {
  const w = parseFloat($('#nlW') && $('#nlW').value) || 100;
  const h = parseFloat($('#nlH') && $('#nlH').value) || 70;
  const shape = ($('#nlShape') && $('#nlShape').value) || 'rect';
  const maxW = 190, maxH = 120;
  const ratio = Math.min(maxW / w, maxH / h);
  const pw = Math.max(8, w * ratio), ph = Math.max(8, h * ratio);
  const x = 150 - pw / 2, y = 120 - ph / 2;
  const r = $('#nlPrevShape');
  if (r) {
    r.setAttribute('x', x); r.setAttribute('y', y);
    r.setAttribute('width', pw); r.setAttribute('height', ph);
    if (shape === 'ellipse') r.setAttribute('rx', pw / 2);
    else if (shape === 'round') r.setAttribute('rx', Math.min(10, pw / 5));
    else r.setAttribute('rx', 0);
  }
  const wl = $('#nlPrevWLine');
  if (wl) { wl.setAttribute('x1', x); wl.setAttribute('x2', x + pw); wl.setAttribute('y1', y - 14); wl.setAttribute('y2', y - 14); }
  const wt = $('#nlPrevWText');
  if (wt) { wt.setAttribute('x', 150); wt.setAttribute('y', y - 20); wt.textContent = w + 'mm'; }
  const hl = $('#nlPrevHLine');
  if (hl) { hl.setAttribute('y1', y); hl.setAttribute('y2', y + ph); hl.setAttribute('x1', x - 14); hl.setAttribute('x2', x - 14); }
  const ht = $('#nlPrevHText');
  if (ht) { ht.setAttribute('transform', `rotate(-90 ${x - 22} 120)`); ht.setAttribute('x', x - 22); ht.setAttribute('y', 120); ht.textContent = h + 'mm'; }
}
function openNewLabelDialog() {
  const m = $('#newLabelModal'); if (!m) return;
  $('#nlName').value = '';
  $('#nlW').value = 100; $('#nlH').value = 70;
  $('#nlCols').value = 1; $('#nlColGap').value = 2;
  $('#nlOffsetX').value = 0; $('#nlOffsetY').value = 0;
  $('#nlShape').value = 'rect'; $('#nlLabelGap').value = 2;
  $('#nlMore').open = false;
  updateNewLabelPreview();
  m.hidden = false;
  setTimeout(() => $('#nlName').focus(), 50);
}
function closeNewLabelDialog() { const m = $('#newLabelModal'); if (m) m.hidden = true; }
function applyNewLabel() {
  const w = parseFloat($('#nlW').value), h = parseFloat($('#nlH').value);
  if (!isFinite(w) || w < 10 || w > 500 || !isFinite(h) || h < 10 || h > 500) { toast('宽高需在 10-500 mm 之间'); return; }
  const docObj = makeDoc();
  docObj.name = ($('#nlName').value || '').trim() || '未命名标签';
  docObj.width = w; docObj.height = h;
  docObj.cols = Math.max(1, parseInt($('#nlCols').value, 10) || 1);
  docObj.colGap = Math.max(0, parseFloat($('#nlColGap').value) || 0);
  docObj.offsetX = parseFloat($('#nlOffsetX').value) || 0;
  docObj.offsetY = parseFloat($('#nlOffsetY').value) || 0;
  docObj.labelShape = $('#nlShape').value || 'rect';
  docObj.labelGap = Math.max(0, parseFloat($('#nlLabelGap').value) || 0);
  captureActive();
  const t = makeTab(docObj);
  tabs.push(t); activateTab(t); updateEmptyState();
  commit();
  closeNewLabelDialog();
  toast('已新建标签：' + docObj.name);
}
function bindNewLabelDialog() {
  if (!$('#newLabelModal')) return;
  if ($('#nlClose')) $('#nlClose').onclick = closeNewLabelDialog;
  if ($('#nlOk')) $('#nlOk').onclick = applyNewLabel;
  ['nlW','nlH','nlShape'].forEach(id => { const el = $('#' + id); if (el) el.addEventListener('input', updateNewLabelPreview); });
  $('#newLabelModal').addEventListener('click', (e) => { if (e.target.id === 'newLabelModal') closeNewLabelDialog(); });
  if ($('#btnNew')) $('#btnNew').onclick = openNewLabelDialog;
  if ($('#weNew')) $('#weNew').onclick = openNewLabelDialog;
  if ($('#btnLabelSetup')) $('#btnLabelSetup').onclick = openNewLabelDialog;
}

function init() {
  bindUpdateToast();
  bindNewLabelDialog();
  bindTableCtxMenu();
  // Defer the network check so it never delays first paint.
  setTimeout(checkForUpdate, 1200);
  // Start with NO document tab (no stray "未命名标签"). A blank working doc
  // still exists in memory so the canvas can render, but it has no tab until
  // the user opens a file or clicks the + button.
  commit();
  renderTabBar();
  updateEmptyState();
  bindDocSize();
  // Defer fit until layout is measurable (window may not be laid out yet).
  requestAnimationFrame(() => fitZoom());
  refreshAll();
  $('#versionTag').textContent = 'v' + (api ? '1.0' : '1.0');
  if (api && api.app) api.app.version().then(v => { if (v) $('#versionTag').textContent = 'v' + v; }).catch(() => {});
  if ($('#printerSelect')) refreshPrinters();

  // File association repair: double-clicking .ddl/.xtc should open this app.
  const fixBtn = $('#btnFixAssoc');
  const assocTip = $('#assocTip');
  if (fixBtn && api && api.assoc) {
    fixBtn.addEventListener('click', async () => {
      fixBtn.disabled = true;
      assocTip.textContent = '正在修复...';
      try {
        const r = await api.assoc.fix();
        assocTip.textContent = r.ok ? '已修复，双击标签文件即可打开' : ('修复失败：' + (r.error || '未知错误'));
      } catch (e) {
        assocTip.textContent = '修复失败：' + (e.message || e);
      } finally {
        fixBtn.disabled = false;
      }
    });
  }
}
init();
