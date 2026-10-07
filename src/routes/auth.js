const express = require('express');
const bcrypt = require('bcryptjs');
const { isAdminConfigured, getAdminCredentials, setAdminCredentials } = require('../db');

const router = express.Router();

router.get('/status', (req, res) => {
  res.json({
    adminConfigured: isAdminConfigured(),
    authenticated: Boolean(req.session && req.session.authenticated),
    username: req.session?.username || null,
  });
});

// Первичная настройка — доступна только пока учётка администратора ещё не создана.
router.post('/setup', async (req, res) => {
  if (isAdminConfigured()) return res.status(403).json({ error: 'Администратор уже настроен' });
  const { username, password } = req.body || {};
  if (!username || !username.trim()) return res.status(400).json({ error: 'Укажите логин' });
  if (!password || password.length < 8) return res.status(400).json({ error: 'Пароль должен быть не короче 8 символов' });

  const passwordHash = await bcrypt.hash(password, 12);
  setAdminCredentials(username.trim(), passwordHash);
  req.session.authenticated = true;
  req.session.username = username.trim();
  res.json({ ok: true });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });

  const creds = getAdminCredentials();
  if (!creds.passwordHash) return res.status(400).json({ error: 'Администратор ещё не настроен' });

  const ok = creds.username === username.trim() && (await bcrypt.compare(password, creds.passwordHash));
  if (!ok) return res.status(401).json({ error: 'Неверный логин или пароль' });

  req.session.authenticated = true;
  req.session.username = creds.username;
  res.json({ ok: true });
});

router.post('/logout', (req, res) => {
  req.session = null;
  res.json({ ok: true });
});

// Роут смены пароля — единственный в этом публично смонтированном роутере, которому нужна авторизация,
// поэтому проверяем сессию вручную вместо общего middleware requireAuth.
router.post('/change-password', async (req, res) => {
  if (!req.session || !req.session.authenticated) return res.status(401).json({ error: 'Требуется авторизация' });

  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return res.status(400).json({ error: 'Новый пароль должен быть не короче 8 символов' });

  const creds = getAdminCredentials();
  const ok = await bcrypt.compare(currentPassword || '', creds.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Текущий пароль указан неверно' });

  const passwordHash = await bcrypt.hash(newPassword, 12);
  setAdminCredentials(creds.username, passwordHash);
  res.json({ ok: true });
});

module.exports = router;
