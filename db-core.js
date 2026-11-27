// Database core: connection + query logic shared by the main process and tests.
// Pure JS, no Electron dependency — safe to require from either side.
const mysql = require('mysql2/promise');
const mssql = require('mssql');

function makePool(cfg) {
  const type = String(cfg.type || 'mysql').toLowerCase();
  const host = String(cfg.host || 'localhost').trim();
  const port = parseInt(cfg.port, 10) || (type === 'mysql' ? 3306 : 1433);
  const user = String(cfg.user || '').trim();
  const password = String(cfg.password || '');
  const database = String(cfg.database || '').trim();
  const timeout = Math.max(2, Math.min(60, parseInt(cfg.timeout, 10) || 10)) * 1000;
  if (type === 'mysql') {
    return mysql.createPool({
      host, port, user, password, database: database || undefined,
      waitForConnections: true, connectionLimit: 1,
      connectTimeout: timeout,
      charset: cfg.charset || 'utf8mb4'
    });
  }
  if (type === 'sqlserver' || type === 'mssql') {
    return new mssql.ConnectionPool({
      server: host, port, user, password,
      database: database || undefined,
      options: {
        encrypt: !!cfg.encrypt,
        trustServerCertificate: cfg.trustServerCertificate !== false,
        enableArithAbort: true,
        connectionTimeout: timeout,
        requestTimeout: timeout
      },
      pool: { max: 1, min: 0, idleTimeoutMillis: 10000 }
    });
  }
  throw new Error('不支持的数据库类型：' + type);
}

async function testConnection(cfg) {
  const pool = makePool(cfg);
  try {
    if (cfg.type === 'mysql' || !cfg.type) {
      const conn = await pool.getConnection();
      await conn.ping();
      conn.release();
    } else {
      await pool.connect();
      await pool.request().query('SELECT 1 AS ok');
      await pool.close();
    }
    return { ok: true };
  } finally {
    try { if (typeof pool.end === 'function') await pool.end(); } catch (e) { /* ignore */ }
  }
}

async function listTables(cfg) {
  const type = String(cfg.type || 'mysql').toLowerCase();
  const sql = type === 'mysql'
    ? 'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME'
    : "SELECT TABLE_SCHEMA + '.' + TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME";
  const res = await query(cfg, sql, 2000);
  return { ok: true, tables: res.rows.map(r => r.name).filter(Boolean) };
}

async function query(cfg, sql, maxRows) {
  const type = String(cfg.type || 'mysql').toLowerCase();
  const limit = Math.max(1, Math.min(10000, parseInt(maxRows, 10) || 1000));
  const text = String(sql || '').trim();
  if (!text) throw new Error('SQL 语句为空');
  const pool = makePool(cfg);
  try {
    if (type === 'mysql') {
      const [rows, fields] = await pool.query(text);
      const columns = (fields || []).map(f => f.name);
      if (!columns.length && rows && rows.length) columns.push(...Object.keys(rows[0]));
      return { ok: true, columns, rows: rows.slice(0, limit) };
    }
    await pool.connect();
    const result = await pool.request().query(text);
    const recs = result.recordset || [];
    const columns = recs.length ? Object.keys(recs[0]) : (result.columns || []).map(c => c.name);
    await pool.close();
    return { ok: true, columns, rows: recs.slice(0, limit) };
  } finally {
    try { if (typeof pool.end === 'function') await pool.end(); } catch (e) { /* ignore */ }
  }
}

module.exports = { makePool, testConnection, listTables, query };
