// Print log store: pure-JS persistence + filtering, shared by main and tests.
const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 2000;

function storePath(dir) { return path.join(dir, 'print-log.json'); }

function readAll(dir) {
  try {
    const p = storePath(dir);
    if (!fs.existsSync(p)) return [];
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch (e) { return []; }
}

function writeAll(dir, logs) {
  try {
    fs.writeFileSync(storePath(dir), JSON.stringify(logs, null, 2), 'utf8');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

function add(dir, entry) {
  try {
    const logs = readAll(dir);
    const e = Object.assign({ id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), time: new Date().toISOString() }, entry || {});
    logs.unshift(e);
    if (logs.length > MAX_ENTRIES) logs.length = MAX_ENTRIES;
    const w = writeAll(dir, logs);
    return w.ok ? { ok: true, entry: e } : w;
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function list(dir, filter) {
  try {
    const f = filter || {};
    let logs = readAll(dir);
    if (f.keyword) {
      const kw = String(f.keyword).toLowerCase();
      logs = logs.filter(x => [x.labelName, x.filePath, x.fileDir, x.summary, x.printer, x.type]
        .some(v => String(v || '').toLowerCase().includes(kw)));
    }
    if (f.type) logs = logs.filter(x => x.type === f.type);
    if (f.from) logs = logs.filter(x => new Date(x.time) >= new Date(f.from));
    if (f.to) {
      const toDate = new Date(String(f.to).length === 10 ? f.to + 'T23:59:59' : f.to);
      logs = logs.filter(x => new Date(x.time) <= toDate);
    }
    const total = logs.length;
    const offset = Math.max(0, parseInt(f.offset, 10) || 0);
    const limit = Math.max(1, Math.min(500, parseInt(f.limit, 10) || 100));
    return { ok: true, total, entries: logs.slice(offset, offset + limit) };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

function clear(dir) { return writeAll(dir, []); }

module.exports = { add, list, clear, readAll, writeAll, storePath };
