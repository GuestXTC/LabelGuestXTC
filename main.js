// LabelGuestXTC - Electron main process
// Responsible for: app lifecycle, native dialogs, filesystem (JSON / exports),
// and sending label canvases to the system printer / PDF.

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

let mainWindow = null;

// ---- File association / open-with ---------------------------------------
// When a .ddl / .xtc file is double-clicked (or "Open with" is used), Windows
// launches the app with the file path in argv. Collect those paths and send
// them to the renderer once the window is ready.
function pathsFromArgv(argv) {
  return (argv || []).filter(p => typeof p === 'string' && /\.(ddl|xtc)$/i.test(p) && fs.existsSync(p));
}
let pendingOpenPaths = pathsFromArgv(process.argv);
// macOS "open file" events
app.on('open-file', (event, p) => {
  event.preventDefault();
  if (p) pendingOpenPaths.push(p);
});

let rendererReady = false;
function openPathsInRenderer(paths) {
  if (!paths || !paths.length) return;
  // Keep paths queued until the renderer has registered its onOpenPath listener
  // (cold start: did-finish-load fires before app.js finished setting up).
  pendingOpenPaths.push(...paths.filter(p => pendingOpenPaths.indexOf(p) < 0));
  if (rendererReady && mainWindow && !mainWindow.isDestroyed()) flushPendingPaths();
}
function flushPendingPaths() {
  if (!rendererReady || !mainWindow || mainWindow.isDestroyed() || !pendingOpenPaths.length) return;
  const list = pendingOpenPaths.slice(); pendingOpenPaths = [];
  list.forEach(p => mainWindow.webContents.send('file:open-path', p));
}

// ---- Single instance -----------------------------------------------------
// Prevent launching several copies. A second launch (including a double-click
// on a .ddl file) focuses the existing window and opens the file there.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const w = BrowserWindow.getAllWindows()[0] || mainWindow;
    if (w) {
      if (w.isMinimized()) w.restore();
      w.show(); w.focus();
    }
    openPathsInRenderer(pathsFromArgv(argv));
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 680,
    title: 'LabelGuestXTC - 标签设计与打印工作台',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
      contextIsolation: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(() => { if (gotLock) createWindow(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) { rendererReady = false; createWindow(); }
});

// Renderer signals it has registered listeners; now it is safe to deliver any
// queued file-association paths (fixes cold-start double-click opening the app
// but not the file).
ipcMain.handle('renderer:ready', () => {
  rendererReady = true;
  flushPendingPaths();
  return true;
});

// ---- Window controls (custom titlebar buttons) ---------------------------
ipcMain.handle('win:minimize', () => { if (mainWindow) mainWindow.minimize(); });
ipcMain.handle('win:maximize', () => {
  if (mainWindow) { if (mainWindow.isMaximized()) mainWindow.unmaximize(); else mainWindow.maximize(); }
});
ipcMain.handle('win:close', () => { if (mainWindow) mainWindow.close(); });

// ---- DDL / JSON files ----------------------------------------------------
// Read a label file as text regardless of encoding/variant. Such files
// are XML, but real-world files come as UTF-8 (with/without BOM), UTF-16 LE/BE
// (with/without BOM) and occasionally GBK. Reading everything as 'utf8' was
// the reason "open DDL" showed a blank canvas while JSON import worked.
function decodeLabelFile(buf) {
  // UTF-16 LE BOM: FF FE
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.toString('utf16le').replace(/^\uFEFF/, '');
  }
  // UTF-16 BE BOM: FE FF -> byte-swap then decode as LE
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return swap16(buf.slice(2)).toString('utf16le').replace(/^\uFEFF/, '');
  }
  // UTF-8 BOM: EF BB BF (strip the BOM, DOMParser rejects it before <?xml)
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString('utf8').replace(/^\uFEFF/, '');
  }
  // UTF-16 without BOM: count the NUL bytes in the odd/even positions of the
  // first 64 bytes. Checking only the first few bytes fails because 'm'/'l'
  // in "<?xml" also produce a zero high byte at those offsets.
  if (buf.length >= 8) {
    const n = Math.min(buf.length - (buf.length % 2), 64);
    let oddNul = 0, evenNul = 0;
    for (let i = 0; i < n; i += 2) {
      if (buf[i + 1] === 0) oddNul++;   // UTF-16LE: high byte is second
      if (buf[i] === 0) evenNul++;      // UTF-16BE: high byte is first
    }
    if (oddNul > n / 4 || evenNul > n / 4) {
      const b = evenNul > oddNul ? swap16(buf) : buf;
      return b.toString('utf16le').replace(/^\uFEFF/, '');
    }
  }
  // Plain UTF-8. If it is not valid UTF-8, fall back to GBK/GB18030.
  let text = buf.toString('utf8');
  if (text.indexOf('\uFFFD') !== -1) {
    for (const enc of ['gb18030', 'gbk']) {
      try { text = new TextDecoder(enc).decode(buf); break; } catch (_) {}
    }
  }
  return text.replace(/^\uFEFF/, '');
}
function swap16(buf) {
  const b = Buffer.from(buf);
  for (let i = 0; i + 1 < b.length; i += 2) { const t = b[i]; b[i] = b[i + 1]; b[i + 1] = t; }
  return b;
}
function readLabelFile(filePath) {
  return decodeLabelFile(fs.readFileSync(filePath));
}

ipcMain.handle('ddl:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '打开 .ddl 标签文件',
    filters: [{ name: '.ddl 标签文件', extensions: ['ddl'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try {
    const text = readLabelFile(res.filePaths[0]);
    // `xml` kept for backwards compatibility, `text` is the canonical field.
    return { ok: true, path: res.filePaths[0], xml: text, text };
  } catch (e) { return { ok: false, error: e.message }; }
});

// Unified open: accepts both .ddl (XML) and .xtc (our own format). The
// renderer decides which parser to use based on the content, so "打开" and
// "导入" keep working exactly as before. Only the file association for .ddl
// is removed (no double-click open) — importing is untouched.
ipcMain.handle('file:open-any', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '打开标签文件',
    filters: [
      { name: '标签文件 (*.xtc, *.ddl)', extensions: ['xtc', 'ddl'] },
      { name: 'LabelGuestXTC 标签文件 (*.xtc)', extensions: ['xtc'] },
      { name: '.ddl 标签文件 (*.ddl)', extensions: ['ddl'] },
      { name: '所有文件', extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  try { return { ok: true, path: res.filePaths[0], text: readLabelFile(res.filePaths[0]) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Read a known path as text (used by drag & drop and file associations).
ipcMain.handle('file:read', async (event, filePath) => {
  try { return { ok: true, path: filePath, text: readLabelFile(filePath) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// Save content to an exact path (used by "Save" to overwrite current file).
ipcMain.handle('file:save-to', async (event, payload) => {
  try {
    fs.writeFileSync(payload.path, payload.content, 'utf8');
    return { ok: true, file: payload.path };
  } catch (e) { return { ok: false, error: e.message }; }
});

// "Save As": pick filename + format, return both path and chosen type.
ipcMain.handle('file:save-as', async (event, payload) => {
  const base = (payload.name || '标签').replace(/[\\/:*?"<>|]/g, '_');
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '另存为',
    defaultPath: base + '.' + (payload.defaultType === 'ddl' ? 'ddl' : 'xtc'),
    filters: [
      { name: 'LabelGuestXTC 标签文件 (*.xtc)', extensions: ['xtc'] },
      { name: '.ddl 标签文件 (*.ddl)', extensions: ['ddl'] }
    ]
  });
  if (res.canceled) return { ok: false };
  const ext = path.extname(res.filePath).toLowerCase();
  const type = ext === '.ddl' ? 'ddl' : 'xtc';
  const content = type === 'ddl' ? payload.ddlXml : JSON.stringify(payload.doc, null, 2);
  try {
    fs.writeFileSync(res.filePath, content, 'utf8');
    return { ok: true, file: res.filePath, type };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---- Data import ---------------------------------------------------------
ipcMain.handle('data:open', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '打开数据文件',
    filters: [{ name: '表格 / 文本', extensions: ['xlsx', 'xls', 'csv', 'txt'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return { ok: false };
  return { ok: true, path: res.filePaths[0] };
});

// ---- Export --------------------------------------------------------------
ipcMain.handle('export:save-png', async (event, payload) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出 PNG 图片',
    defaultPath: (payload.name || '标签') + '.png',
    filters: [{ name: 'PNG 图片', extensions: ['png'] }]
  });
  if (res.canceled) return { ok: false };
  const buf = Buffer.from(payload.dataUrl.split(',')[1], 'base64');
  fs.writeFileSync(res.filePath, buf);
  return { ok: true, file: res.filePath };
});

ipcMain.handle('export:save-pdf', async (event, payload) => {
  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出 PDF',
    defaultPath: (payload.name || '标签') + '.pdf',
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
  });
  if (res.canceled) return { ok: false };
  const buf = Buffer.from(payload.base64, 'base64');
  fs.writeFileSync(res.filePath, buf);
  return { ok: true, file: res.filePath };
});

// ---- Printing ------------------------------------------------------------
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

// PowerShell script (pure ASCII) that sends arbitrary bytes to a printer RAW port.
// Kept inline so NSIS packaging needs no extra files outside the asar.
const RAW_PRINT_PS = String.raw`param([Parameter(Mandatory=$true)][string]$PrinterName,[Parameter(Mandatory=$true)][string]$DataPath)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO1 {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern int StartDocPrinter(IntPtr h, int lvl, ref DOCINFO1 di);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, IntPtr p, int n, out int w);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
  public static int Send(string printer, byte[] data) {
    IntPtr h = IntPtr.Zero;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return Marshal.GetLastWin32Error();
    DOCINFO1 di = new DOCINFO1();
    di.pDocName = "RAWJOB"; di.pOutputFile = null; di.pDataType = "RAW";
    int job = StartDocPrinter(h, 1, ref di);
    if (job == 0) { int e = Marshal.GetLastWin32Error(); ClosePrinter(h); return e; }
    int total = 0;
    GCHandle pin = GCHandle.Alloc(data, GCHandleType.Pinned);
    try {
      if (!StartPagePrinter(h)) { int e = Marshal.GetLastWin32Error(); EndDocPrinter(h); ClosePrinter(h); return e; }
      while (total < data.Length) {
        IntPtr p = Marshal.UnsafeAddrOfPinnedArrayElement(data, total);
        int n = 0;
        if (!WritePrinter(h, p, data.Length - total, out n) || n <= 0) {
          int e = Marshal.GetLastWin32Error(); EndPagePrinter(h); EndDocPrinter(h); ClosePrinter(h); return e;
        }
        total += n;
      }
      EndPagePrinter(h);
    } finally { pin.Free(); }
    EndDocPrinter(h); ClosePrinter(h);
    return total == data.Length ? 0 : -1;
  }
}
'@
$bytes = [IO.File]::ReadAllBytes($DataPath)
$rc = [RawPrinterHelper]::Send($PrinterName, $bytes)
if ($rc -ne 0) { Write-Output ("RAWPRINT_ERR=" + $rc); exit $rc }
Write-Output ("RAWPRINT_OK=" + $bytes.Length)
`;

// Cache the extracted PS script for the session.
let rawPsPath = null;
function getRawPsPath() {
  if (rawPsPath && fs.existsSync(rawPsPath)) return rawPsPath;
  rawPsPath = path.join(os.tmpdir(), 'labelstudio_rawprint.ps1');
  fs.writeFileSync(rawPsPath, RAW_PRINT_PS, 'ascii');
  return rawPsPath;
}

// macOS / Linux: send the TSPL byte stream through CUPS in raw mode so the
// printer receives our bytes verbatim (no GDI/filter conversion). `lp -o raw`
// requires a raw-capable queue; we also try `lpr -l` as a fallback.
async function sendRawUnix(printerName, buffer, dataPath) {
  const attempts = [
    { cmd: 'lp', args: ['-d', printerName, '-o', 'raw', dataPath] },
    { cmd: 'lp', args: ['-d', printerName, '-o', 'document-format=application/vnd.cups-raw', dataPath] },
    { cmd: 'lpr', args: ['-P', printerName, '-l', dataPath] }
  ];
  let lastErr = '';
  for (const a of attempts) {
    try {
      await execFileAsync(a.cmd, a.args, { maxBuffer: 1024 * 1024 });
      return { ok: true, written: buffer.length, via: a.cmd };
    } catch (e) {
      lastErr = (e.stderr || e.message || '').toString().trim().slice(0, 200);
    }
  }
  return { ok: false, error: 'CUPS 原始打印失败：' + lastErr + '。请确认打印机队列支持 RAW 模式（lpadmin -p <队列> -E -v <设备> -m raw）。' };
}

async function sendRaw(printerName, buffer) {
  if (!printerName) return { ok: false, error: '未选择打印机' };
  if (process.platform !== 'win32') {
    const dataPath = path.join(os.tmpdir(), 'labelstudio_job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.bin');
    fs.writeFileSync(dataPath, buffer);
    try {
      return await sendRawUnix(printerName, buffer, dataPath);
    } catch (e) {
      return { ok: false, error: (e.stderr || e.message || '').toString().trim().slice(0, 300) };
    } finally {
      try { fs.unlinkSync(dataPath); } catch (_) {}
    }
  }
  const psPath = getRawPsPath();
  const dataPath = path.join(os.tmpdir(), 'labelstudio_job_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8) + '.bin');
  fs.writeFileSync(dataPath, buffer);
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', psPath, '-PrinterName', printerName, '-DataPath', dataPath
    ], { windowsHide: true, maxBuffer: 1024 * 1024 });
    const ok = /RAWPRINT_OK=(\d+)/.exec(stdout || '');
    if (ok) return { ok: true, written: parseInt(ok[1]) };
    const err = /RAWPRINT_ERR=(-?\d+)/.exec(stdout || '');
    return { ok: false, error: err ? 'Windows 错误码 ' + err[1] : (stdout || '').trim() };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || '').toString().trim().slice(0, 300) };
  } finally {
    try { fs.unlinkSync(dataPath); } catch (_) {}
  }
}

// Build TSPL2 commands for one 1-bit bitmap label.
// bitmap: { widthBytes, height, data:Buffer } where bit 0 = black dot.
// paperMode: 'gap' (gap paper), 'continuous' (no gap), 'detect' (auto-calibrate).
function buildTsplCommands(opts) {
  const { widthMm, heightMm, gapMm, density, copies, dark, bitmaps, paperMode, offsetDot } = opts;
  const chunks = [];
  const cmd = (s) => chunks.push(Buffer.from(s + '\r\n', 'ascii'));
  // SIZE must be first command
  cmd('SIZE ' + widthMm + ' mm,' + heightMm + ' mm');
  if (paperMode === 'continuous') {
    cmd('GAP 0 mm,0 mm');
  } else if (paperMode === 'detect') {
    // Re-calibrate on each first job only; subsequent jobs reuse learned gap.
    // (opts.calibrate is set by the test-page action.)
    if (opts.calibrate) cmd('GAPDETECT');
    cmd('GAP ' + (gapMm != null ? gapMm : 3) + ' mm,0 mm');
  } else {
    cmd('GAP ' + (gapMm != null ? gapMm : 3) + ' mm,0 mm');
  }
  cmd('DIRECTION 0,0');           // forward feed, no mirror (rotate=0)
  cmd('DENSITY ' + Math.max(0, Math.min(15, density != null ? density : 8)));
  cmd('REFERENCE 0,0');
  if (offsetDot) cmd('OFFSET ' + Math.round(offsetDot) + ' dot'); // stop-position fine tune

  // IMPORTANT: In TSPL, BITMAP draws into the printer's image buffer and CLS
  // wipes it. To print N copies you must emit a full CLS + BITMAP(s) + PRINT
  // sequence N times. (Trying to stack multiple BITMAPs with CLS in between
  // leaves only the last one, and a single PRINT outputs just one label.)
  const n = Math.max(1, copies || 1);
  for (let i = 0; i < n; i++) {
    cmd('CLS');
    for (const bm of bitmaps) {
      const header = 'BITMAP ' + (bm.x || 0) + ',' + (bm.y || 0) + ',' + bm.widthBytes + ',' + bm.height + ',0,';
      chunks.push(Buffer.from(header, 'ascii'));
      chunks.push(bm.data);
      chunks.push(Buffer.from('\r\n', 'ascii'));
    }
    cmd('PRINT 1,1');
  }
  return Buffer.concat(chunks);
}

// RAW TSPL print: renderer sends 203DPI 1-bit bitmaps (base64) per label.
ipcMain.handle('print:raw', async (event, payload) => {
  try {
    const { printerName, widthMm, heightMm, gapMm, density, dark, copies, bitmaps, paperMode, offsetDot, calibrate } = payload;
    if (!printerName) return { ok: false, error: '未选择打印机' };
    // bitmaps: array of labels, each label = array of {x,y,widthBytes,height,data(base64)}
    const jobs = [];
    const perLabel = Math.max(1, copies || 1);
    for (const labelBms of bitmaps) {
      const bms = labelBms.map(b => ({
        x: b.x || 0, y: b.y || 0,
        widthBytes: b.widthBytes, height: b.height,
        data: Buffer.from(b.data, 'base64')
      }));
      jobs.push(buildTsplCommands({
        widthMm, heightMm, gapMm, density, copies: perLabel, dark, bitmaps: bms,
        paperMode: paperMode || 'gap', offsetDot: offsetDot || 0, calibrate: !!calibrate
      }));
    }
    // One RAW document per label keeps feed control exact.
    for (const job of jobs) {
      const r = await sendRaw(printerName, job);
      if (!r.ok) return r;
    }
    return { ok: true, count: jobs.length };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

ipcMain.handle('print:printers', async () => {
  try {
    const w = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false } });
    await w.loadURL('about:blank');
    const list = await w.webContents.getPrintersAsync();
    w.destroy();
    return { ok: true, printers: list.map(p => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!p.isDefault })) };
  } catch (e) {
    return { ok: false, error: e.message || String(e), printers: [] };
  }
});

// Legacy GDI/system print path (for ordinary desktop printers).
ipcMain.handle('print:labels', async (event, payload) => {
  return new Promise((resolve) => {
    const { dataUrls, widthMm, heightMm, silent } = payload;
    const printWin = new BrowserWindow({
      show: false,
      width: 800,
      height: 600,
      webPreferences: { nodeIntegration: false, contextIsolation: true }
    });
    const mmToPx = 3.7795; // 96dpi
    const wpx = Math.round(widthMm * mmToPx);
    const hpx = Math.round(heightMm * mmToPx);
    const items = dataUrls.map(src =>
      `<div class="label" style="width:${wpx}px;height:${hpx}px"><img src="${src}" /></div>`
    ).join('');
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { size: ${widthMm}mm ${heightMm}mm; margin: 0; }
      html,body { margin:0; padding:0; }
      .label { width:${wpx}px; height:${hpx}px; page-break-after: always; break-after: page; overflow:hidden; }
      .label:last-child { page-break-after:auto; break-after:auto; }
      img { width:100%; height:100%; display:block; }
    </style></head><body>${items}</body></html>`;
    printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    printWin.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        printWin.webContents.print({ silent: !!silent, printBackground: true }, (success, error) => {
          printWin.destroy();
          resolve({ ok: !!success, error: error || '' });
        });
      }, 300);
    });
  });
});

ipcMain.handle('app:open-external', async (event, url) => {
  if (typeof url === 'string' && /^https?:\/\//i.test(url)) { shell.openExternal(url); return { ok: true }; }
  return { ok: false };
});
ipcMain.handle('app:version', async () => app.getVersion());
ipcMain.handle('app:userData', async () => app.getPath('userData'));

// ---- Database connections (MySQL / SQL Server) --------------------------
// Connection/query logic lives in db-core.js (shared with tests); the main
// process only wires it to IPC and persists saved configs locally.
const dbCore = require('./db-core');

function dbConfigPath() { return path.join(app.getPath('userData'), 'db-connections.json'); }

function readDbConfigs() {
  try {
    const p = dbConfigPath();
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch (e) { return {}; }
}
function writeDbConfigs(cfg) {
  try {
    fs.writeFileSync(dbConfigPath(), JSON.stringify(cfg || {}, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

ipcMain.handle('db:test', async (event, cfg) => {
  try { return await dbCore.testConnection(cfg || {}); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('db:tables', async (event, cfg) => {
  try { return await dbCore.listTables(cfg || {}); }
  catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('db:query', async (event, payload) => {
  try {
    if (!payload || !payload.config) return { ok: false, error: '缺少连接配置' };
    return await dbCore.query(payload.config, payload.sql, payload.maxRows);
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
});

ipcMain.handle('db:configs:load', async () => readDbConfigs());
ipcMain.handle('db:configs:save', async (event, cfg) => writeDbConfigs(cfg));

// ---- Print log ----------------------------------------------------------
// Pure-JS store in log-store.js; main only wires IPC and supplies userData dir.
const logStore = require('./log-store');
const logDir = () => app.getPath('userData');

ipcMain.handle('printlog:add', async (event, entry) => logStore.add(logDir(), entry));
ipcMain.handle('printlog:list', async (event, filter) => logStore.list(logDir(), filter || {}));
ipcMain.handle('printlog:clear', async () => logStore.clear(logDir()));

// ---- Update check -------------------------------------------------------
// Silently asks GitHub for the latest release. Never blocks startup: a short
// timeout and swallowed errors keep the app fully offline-friendly.
const https = require('https');
function compareVersions(a, b) {
  const na = String(a || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  const nb = String(b || '').replace(/^v/, '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i] || 0, y = nb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}
ipcMain.handle('app:check-update', async () => {
  const current = app.getVersion();
  return await new Promise(resolve => {
    const req = https.get({
      hostname: 'api.github.com',
      path: '/repos/GuestXTC/LabelGuestXTC/releases/latest',
      headers: {
        'User-Agent': 'LabelGuestXTC',
        'Accept': 'application/vnd.github+json'
      },
      timeout: 6000
    }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 200000) req.destroy(); });
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return resolve({ update: false });
          const rel = JSON.parse(body);
          const latest = String(rel.tag_name || '').replace(/^v/, '');
          if (!latest) return resolve({ update: false });
          const hasUpdate = compareVersions(latest, current) > 0;
          resolve({
            update: hasUpdate,
            version: latest,
            current,
            url: rel.html_url || 'https://github.com/GuestXTC/LabelGuestXTC/releases',
            name: rel.name || ('v' + latest)
          });
        } catch (e) { resolve({ update: false }); }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ update: false }); });
    req.on('error', () => { resolve({ update: false }); });
  });
});

// ---- File association repair -------------------------------------------
// NSIS registers the LabelGuestXTC File ProgID at install time, but a
// pre-existing user choice (.ddl/.xtc opened by another app) can override it.
// These handlers let the user repair the association with one click, using
// HKCU (per-user) registry writes so no administrator rights are needed.
const ASSOC_PROGID = 'LabelGuestXTC File';
const ASSOC_EXTS = ['xtc']; // only .xtc gets a double-click association; .ddl can still be imported from within the app

function regQueryHKCU(subKey) {
  try {
    const out = execFileSync('reg', ['query', `HKCU\\Software\\Classes\\${subKey}`, '/ve'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const m = out.match(/REG_SZ\s+(.*)$/m);
    return m ? m[1].trim() : null;
  } catch (_) { return null; }
}

function regAddHKCU(subKey, value) {
  execFileSync('reg', ['add', `HKCU\\Software\\Classes\\${subKey}`, '/ve',
    '/t', 'REG_SZ', '/d', value, '/f'],
    { encoding: 'utf8', windowsHide: true, timeout: 5000 });
}

ipcMain.handle('assoc:status', async () => {
  if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 支持文件关联' };
  const result = {};
  for (const ext of ASSOC_EXTS) {
    result[ext] = regQueryHKCU(`.${ext}`);
  }
  return { ok: true, current: result, progId: ASSOC_PROGID };
});

ipcMain.handle('assoc:fix', async () => {
  if (process.platform !== 'win32') return { ok: false, error: '仅 Windows 支持文件关联' };
  try {
    // Per-user ProgID registration (points to this exe).
    const exePath = app.getPath('exe');
    regAddHKCU(`${ASSOC_PROGID}\\shell\\open\\command`, `"${exePath}" "%1"`);
    regAddHKCU(ASSOC_PROGID, 'LabelGuestXTC 标签文件');
    // Bind each extension to our ProgID at the user level (overrides old choice).
    for (const ext of ASSOC_EXTS) {
      regAddHKCU(`.${ext}`, ASSOC_PROGID);
      regAddHKCU(`.${ext}\\OpenWithProgids\\${ASSOC_PROGID}`, '');
    }
    // Tell Windows the associations changed.
    try {
      execFileSync('rundll32', ['user32.dll,UpdatePerUserSystemParameters'],
        { windowsHide: true, timeout: 5000 });
    } catch (_) { /* best effort */ }
    return { ok: true, progId: ASSOC_PROGID, exts: ASSOC_EXTS };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).toString().trim().slice(0, 300) };
  }
});
