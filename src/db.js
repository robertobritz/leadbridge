import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new DatabaseSync(config.dbPath);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    store_key TEXT NOT NULL,
    email TEXT NOT NULL,
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    tags TEXT,
    status TEXT NOT NULL,
    action TEXT,
    customer_id TEXT,
    warnings TEXT,
    error_message TEXT,
    request_json TEXT,
    response_json TEXT,
    origin TEXT,
    ip_hash TEXT,
    duration_ms INTEGER,
    retry_of INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_created ON submissions (created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_submissions_store ON submissions (store_key);
  CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions (status);
  CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions (email);

  -- Tokens OAuth expiring offline (access_token + refresh_token), sempre gravados
  -- ja criptografados (AES-256-GCM) por src/tokenCrypto.js. Nunca texto puro.
  CREATE TABLE IF NOT EXISTS oauth_tokens (
    store_key TEXT PRIMARY KEY,
    access_token_enc TEXT NOT NULL,
    access_token_expires_at TEXT NOT NULL,
    refresh_token_enc TEXT NOT NULL,
    refresh_token_expires_at TEXT NOT NULL,
    scope TEXT,
    updated_at TEXT NOT NULL
  );
`);

/** O IP nunca e gravado em texto puro: guardamos apenas um hash para deteccao de abuso. */
export function hashIp(ip) {
  if (!ip) return null;
  return crypto.createHmac('sha256', config.sessionSecret).update(String(ip)).digest('hex').slice(0, 32);
}

const insertStmt = db.prepare(`
  INSERT INTO submissions (
    created_at, store_key, email, first_name, last_name, phone, tags,
    status, action, customer_id, warnings, error_message,
    request_json, response_json, origin, ip_hash, duration_ms, retry_of
  ) VALUES (
    @created_at, @store_key, @email, @first_name, @last_name, @phone, @tags,
    @status, @action, @customer_id, @warnings, @error_message,
    @request_json, @response_json, @origin, @ip_hash, @duration_ms, @retry_of
  )
`);

export function insertSubmission(row) {
  const result = insertStmt.run({
    created_at: new Date().toISOString(),
    store_key: row.storeKey,
    email: row.email,
    first_name: row.firstName || null,
    last_name: row.lastName || null,
    phone: row.phone || null,
    tags: JSON.stringify(row.tags || []),
    status: row.status,
    action: row.action || null,
    customer_id: row.customerId || null,
    warnings: JSON.stringify(row.warnings || []),
    error_message: row.errorMessage || null,
    request_json: JSON.stringify(row.request || {}),
    response_json: JSON.stringify(row.response || {}),
    origin: row.origin || null,
    ip_hash: row.ipHash || null,
    duration_ms: row.durationMs ?? null,
    retry_of: row.retryOf ?? null,
  });
  return result.lastInsertRowid;
}

function mapRow(row) {
  if (!row) return null;
  const safeParse = (value, fallback) => {
    try {
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    id: row.id,
    createdAt: row.created_at,
    storeKey: row.store_key,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    phone: row.phone,
    tags: safeParse(row.tags, []),
    status: row.status,
    action: row.action,
    customerId: row.customer_id,
    warnings: safeParse(row.warnings, []),
    errorMessage: row.error_message,
    request: safeParse(row.request_json, {}),
    response: safeParse(row.response_json, {}),
    origin: row.origin,
    durationMs: row.duration_ms,
    retryOf: row.retry_of,
  };
}

export function listSubmissions({ storeKey, status, search, page = 1, perPage = 25 }) {
  const where = [];
  const params = {};

  if (storeKey) {
    where.push('store_key = @storeKey');
    params.storeKey = storeKey;
  }
  if (status) {
    where.push('status = @status');
    params.status = status;
  }
  if (search) {
    where.push('(email LIKE @search OR first_name LIKE @search OR last_name LIKE @search OR phone LIKE @search)');
    params.search = `%${search}%`;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.prepare(`SELECT COUNT(*) AS total FROM submissions ${clause}`).get(params).total;

  const safePerPage = Math.min(Math.max(Number(perPage) || 25, 5), 100);
  const safePage = Math.max(Number(page) || 1, 1);
  const offset = (safePage - 1) * safePerPage;

  const rows = db
    .prepare(`SELECT * FROM submissions ${clause} ORDER BY id DESC LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: safePerPage, offset });

  return {
    total,
    page: safePage,
    perPage: safePerPage,
    pages: Math.max(Math.ceil(total / safePerPage), 1),
    items: rows.map(mapRow),
  };
}

export function getSubmission(id) {
  return mapRow(db.prepare('SELECT * FROM submissions WHERE id = ?').get(id));
}

export function getStats() {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const totals = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
       FROM submissions`,
    )
    .get();

  const last24h = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
       FROM submissions WHERE created_at >= ?`,
    )
    .get(since24h);

  const perStore = db
    .prepare(
      `SELECT
         store_key AS storeKey,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error,
         MAX(created_at) AS lastAt
       FROM submissions
       WHERE created_at >= ?
       GROUP BY store_key`,
    )
    .all(since7d);

  const lastError = mapRow(
    db.prepare("SELECT * FROM submissions WHERE status = 'error' ORDER BY id DESC LIMIT 1").get(),
  );

  const lastSuccess = mapRow(
    db.prepare("SELECT * FROM submissions WHERE status = 'success' ORDER BY id DESC LIMIT 1").get(),
  );

  return {
    totals: {
      total: totals.total || 0,
      success: totals.success || 0,
      error: totals.error || 0,
    },
    last24h: {
      total: last24h.total || 0,
      success: last24h.success || 0,
      error: last24h.error || 0,
    },
    perStore,
    lastError: lastError ? { id: lastError.id, createdAt: lastError.createdAt, storeKey: lastError.storeKey, errorMessage: lastError.errorMessage } : null,
    lastSuccess: lastSuccess ? { id: lastSuccess.id, createdAt: lastSuccess.createdAt, storeKey: lastSuccess.storeKey } : null,
  };
}

/** Buckets por hora das ultimas 48h, usados pela faixa de atividade do painel. */
export function getHourlyActivity(hours = 48, storeKey = null) {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  since.setUTCMinutes(0, 0, 0);

  const params = [since.toISOString()];
  let clause = 'created_at >= ?';
  if (storeKey) {
    clause += ' AND store_key = ?';
    params.push(storeKey);
  }

  const rows = db
    .prepare(
      `SELECT substr(created_at, 1, 13) AS hour,
              SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS error
       FROM submissions
       WHERE ${clause}
       GROUP BY hour`,
    )
    .all(...params);

  const map = new Map(rows.map((row) => [row.hour, row]));
  const buckets = [];

  for (let i = hours - 1; i >= 0; i -= 1) {
    const date = new Date(Date.now() - i * 60 * 60 * 1000);
    date.setUTCMinutes(0, 0, 0);
    const key = date.toISOString().slice(0, 13);
    const found = map.get(key);
    buckets.push({
      hour: `${key}:00:00.000Z`,
      success: found ? found.success || 0 : 0,
      error: found ? found.error || 0 : 0,
    });
  }

  return buckets;
}

/** Evita reprocessar o mesmo lead varias vezes em sequencia (duplo clique, reenvio). */
export function hasRecentSuccess(storeKey, email, windowSeconds = 60) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const row = db
    .prepare(
      "SELECT id FROM submissions WHERE store_key = ? AND email = ? AND status = 'success' AND created_at >= ? LIMIT 1",
    )
    .get(storeKey, email, since);
  return Boolean(row);
}

export function purgeOldSubmissions() {
  if (!config.retentionDays || config.retentionDays <= 0) return 0;
  const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare('DELETE FROM submissions WHERE created_at < ?').run(cutoff);
  return result.changes;
}

const upsertOAuthTokensStmt = db.prepare(`
  INSERT INTO oauth_tokens (
    store_key, access_token_enc, access_token_expires_at,
    refresh_token_enc, refresh_token_expires_at, scope, updated_at
  ) VALUES (
    @storeKey, @accessTokenEnc, @accessTokenExpiresAt,
    @refreshTokenEnc, @refreshTokenExpiresAt, @scope, @updatedAt
  )
  ON CONFLICT(store_key) DO UPDATE SET
    access_token_enc = excluded.access_token_enc,
    access_token_expires_at = excluded.access_token_expires_at,
    refresh_token_enc = excluded.refresh_token_enc,
    refresh_token_expires_at = excluded.refresh_token_expires_at,
    scope = excluded.scope,
    updated_at = excluded.updated_at
`);

/** Grava (ou substitui) os tokens OAuth ja criptografados de uma loja. */
export function saveOAuthTokens(storeKey, tokens) {
  upsertOAuthTokensStmt.run({
    storeKey,
    accessTokenEnc: tokens.accessTokenEnc,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenEnc: tokens.refreshTokenEnc,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    scope: tokens.scope || '',
    updatedAt: new Date().toISOString(),
  });
}

/** Le a linha bruta (ainda criptografada) de tokens OAuth de uma loja. */
export function getOAuthTokensRaw(storeKey) {
  return db.prepare('SELECT * FROM oauth_tokens WHERE store_key = ?').get(storeKey) || null;
}

export function deleteOAuthTokens(storeKey) {
  db.prepare('DELETE FROM oauth_tokens WHERE store_key = ?').run(storeKey);
}

export default db;
