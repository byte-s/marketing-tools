const express = require('express');
const { getAllSettings, setSettings } = require('../db');

const router = express.Router();

const SECRET_KEYS = new Set(['bitrix24_webhook_url', 'metrika_token', 'direct_token', 'openai_api_key', 'pagespeed_api_key']);
// Служебные ключи авторизации хранятся в той же таблице settings, но никогда не должны уходить на фронтенд.
const INTERNAL_KEYS = new Set(['session_secret', 'auth_username', 'auth_password_hash']);

function mask(value) {
  if (!value) return '';
  if (value.length <= 8) return '••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}

router.get('/', (req, res) => {
  const settings = getAllSettings();
  const out = {};
  for (const [key, value] of Object.entries(settings)) {
    if (INTERNAL_KEYS.has(key)) continue;
    out[key] = SECRET_KEYS.has(key) ? { masked: mask(value), set: Boolean(value) } : value;
  }
  res.json(out);
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const allowed = [
    'bitrix24_webhook_url',
    'bitrix24_category_ids',
    'metrika_token',
    'direct_token',
    'direct_login',
    'openai_api_key',
    'openai_base_url',
    'openai_model',
    'pagespeed_api_key',
  ];
  const toSave = {};
  for (const key of allowed) {
    if (body[key] !== undefined && body[key] !== '__unchanged__') {
      toSave[key] = body[key];
    }
  }
  setSettings(toSave);
  res.json({ ok: true });
});

module.exports = router;
