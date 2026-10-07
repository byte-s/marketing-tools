const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'app.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS collected_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    label TEXT,
    period_from TEXT,
    period_to TEXT,
    fetched_at TEXT NOT NULL,
    summary TEXT,
    data TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analyses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    data_ids TEXT NOT NULL,
    question TEXT,
    result TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    metrika_counter_id TEXT,
    site_own_urls TEXT,
    site_sitemap_url TEXT,
    site_competitor_urls TEXT,
    created_at TEXT NOT NULL
  );
`);

// На старых базах в collected_data может не быть колонки site_id — добавляем, если её ещё нет.
try {
  db.exec('ALTER TABLE collected_data ADD COLUMN site_id INTEGER');
} catch {
  // колонка уже существует
}

// Список ID источников Bitrix24 (SOURCE_ID), которые относятся именно к этому сайту —
// нужен, чтобы показывать по сайту срез CRM-данных (лиды/сделки), а не весь аккаунт целиком.
try {
  db.exec('ALTER TABLE sites ADD COLUMN bitrix24_source_ids TEXT');
} catch {
  // колонка уже существует
}

// Миграция: если есть старые глобальные настройки счётчика/сайта, а таблица sites пустая — создаём из них первый сайт.
function migrateLegacySiteSettings() {
  const hasSites = db.prepare('SELECT COUNT(*) AS c FROM sites').get().c > 0;
  if (hasSites) return;
  const settings = getAllSettings();
  const hasLegacyData = settings.metrika_counter_id || settings.site_own_urls || settings.site_sitemap_url;
  if (!hasLegacyData) return;
  db.prepare(
    `INSERT INTO sites (name, metrika_counter_id, site_own_urls, site_sitemap_url, site_competitor_urls, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'Основной сайт',
    settings.metrika_counter_id || '',
    settings.site_own_urls || '',
    settings.site_sitemap_url || '',
    settings.site_competitor_urls || '',
    new Date().toISOString()
  );
}

// Секрет для подписи сессионных cookie — генерируется один раз и хранится в БД,
// чтобы перезапуск сервера (деплой, pm2 restart) не разлогинивал всех пользователей.
function getSessionSecret() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('session_secret');
  if (row && row.value) return row.value;
  const secret = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('session_secret', secret);
  return secret;
}

function isAdminConfigured() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth_password_hash');
  return Boolean(row && row.value);
}

function getAdminCredentials() {
  const username = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth_username');
  const passwordHash = db.prepare('SELECT value FROM settings WHERE key = ?').get('auth_password_hash');
  return { username: username?.value || '', passwordHash: passwordHash?.value || '' };
}

function setAdminCredentials(username, passwordHash) {
  const stmt = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  stmt.run('auth_username', username);
  stmt.run('auth_password_hash', passwordHash);
}

function getSetting(key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function getAllSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const row of rows) out[row.key] = row.value;
  return out;
}

function setSettings(obj) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [key, value] of Object.entries(obj)) {
    stmt.run(key, value == null ? '' : String(value));
  }
}

function insertCollectedData({ source, label, periodFrom, periodTo, summary, data, siteId }) {
  const stmt = db.prepare(`
    INSERT INTO collected_data (source, label, period_from, period_to, fetched_at, summary, data, site_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    source,
    label || null,
    periodFrom || null,
    periodTo || null,
    new Date().toISOString(),
    summary || null,
    JSON.stringify(data),
    siteId || null
  );
  return Number(result.lastInsertRowid);
}

function listCollectedData(source) {
  const rows = source
    ? db.prepare('SELECT id, source, label, period_from, period_to, fetched_at, summary, site_id FROM collected_data WHERE source = ? ORDER BY id DESC').all(source)
    : db.prepare('SELECT id, source, label, period_from, period_to, fetched_at, summary, site_id FROM collected_data ORDER BY id DESC').all();
  return rows;
}

function getCollectedData(id) {
  const row = db.prepare('SELECT * FROM collected_data WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

function getLatestCollectedData(source, siteId) {
  const row = siteId
    ? db.prepare('SELECT * FROM collected_data WHERE source = ? AND site_id = ? ORDER BY id DESC LIMIT 1').get(source, siteId)
    : db.prepare('SELECT * FROM collected_data WHERE source = ? ORDER BY id DESC LIMIT 1').get(source);
  if (!row) return null;
  return { ...row, data: JSON.parse(row.data) };
}

function insertAnalysis({ dataIds, question, result }) {
  const stmt = db.prepare(`
    INSERT INTO analyses (created_at, data_ids, question, result)
    VALUES (?, ?, ?, ?)
  `);
  const r = stmt.run(new Date().toISOString(), JSON.stringify(dataIds), question || null, result);
  return Number(r.lastInsertRowid);
}

function listAnalyses() {
  return db.prepare('SELECT id, created_at, data_ids, question FROM analyses ORDER BY id DESC').all();
}

function getAnalysis(id) {
  const row = db.prepare('SELECT * FROM analyses WHERE id = ?').get(id);
  if (!row) return null;
  return { ...row, data_ids: JSON.parse(row.data_ids) };
}

function insertChatMessage(role, content) {
  const stmt = db.prepare('INSERT INTO chat_messages (role, content, created_at) VALUES (?, ?, ?)');
  const r = stmt.run(role, content, new Date().toISOString());
  return Number(r.lastInsertRowid);
}

function listChatMessages(limit = 50) {
  const rows = db.prepare('SELECT id, role, content, created_at FROM chat_messages ORDER BY id DESC LIMIT ?').all(limit);
  return rows.reverse();
}

function clearChatMessages() {
  db.exec('DELETE FROM chat_messages');
}

function listSites() {
  return db.prepare('SELECT * FROM sites ORDER BY id ASC').all();
}

function getSite(id) {
  return db.prepare('SELECT * FROM sites WHERE id = ?').get(id) || null;
}

function createSite({ name, metrikaCounterId, siteOwnUrls, siteSitemapUrl, siteCompetitorUrls, bitrix24SourceIds }) {
  const stmt = db.prepare(`
    INSERT INTO sites (name, metrika_counter_id, site_own_urls, site_sitemap_url, site_competitor_urls, bitrix24_source_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const r = stmt.run(name, metrikaCounterId || '', siteOwnUrls || '', siteSitemapUrl || '', siteCompetitorUrls || '', bitrix24SourceIds || '', new Date().toISOString());
  return Number(r.lastInsertRowid);
}

function updateSite(id, { name, metrikaCounterId, siteOwnUrls, siteSitemapUrl, siteCompetitorUrls, bitrix24SourceIds }) {
  db.prepare(`
    UPDATE sites SET name = ?, metrika_counter_id = ?, site_own_urls = ?, site_sitemap_url = ?, site_competitor_urls = ?, bitrix24_source_ids = ?
    WHERE id = ?
  `).run(name, metrikaCounterId || '', siteOwnUrls || '', siteSitemapUrl || '', siteCompetitorUrls || '', bitrix24SourceIds || '', id);
}

function deleteSite(id) {
  db.prepare('DELETE FROM sites WHERE id = ?').run(id);
}

migrateLegacySiteSettings();

module.exports = {
  db,
  getSetting,
  getAllSettings,
  setSettings,
  insertCollectedData,
  listCollectedData,
  getCollectedData,
  getLatestCollectedData,
  insertAnalysis,
  listAnalyses,
  getAnalysis,
  listSites,
  getSite,
  createSite,
  updateSite,
  deleteSite,
  insertChatMessage,
  listChatMessages,
  clearChatMessages,
  getSessionSecret,
  isAdminConfigured,
  getAdminCredentials,
  setAdminCredentials,
};
