const express = require('express');
const path = require('node:path');
const cookieSession = require('cookie-session');

const { getSessionSecret } = require('./src/db');
const { requireAuth } = require('./src/middleware/requireAuth');

const authRouter = require('./src/routes/auth');
const settingsRouter = require('./src/routes/settings');
const collectRouter = require('./src/routes/collect');
const analyzeRouter = require('./src/routes/analyze');
const dashboardRouter = require('./src/routes/dashboard');
const sitesRouter = require('./src/routes/sites');
const chatRouter = require('./src/routes/chat');

const app = express();
app.use(express.json({ limit: '5mb' }));

app.use(
  cookieSession({
    name: 'session',
    keys: [getSessionSecret()],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    // За HTTPS-прокси выставьте COOKIE_SECURE=true, чтобы cookie сессии отправлялась только по HTTPS.
    secure: process.env.COOKIE_SECURE === 'true',
  })
);

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Публичные роуты авторизации и сами страницы входа/настройки — без requireAuth.
app.use('/api/auth', authRouter);
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'setup.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(__dirname, 'public', 'style.css')));

// Всё, что ниже, требует авторизации.
app.use(requireAuth);

app.use('/api/settings', settingsRouter);
app.use('/api/collect', collectRouter);
app.use('/api/analyze', analyzeRouter);
app.use('/api/dashboard', dashboardRouter);
app.use('/api/sites', sitesRouter);
app.use('/api/chat', chatRouter);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 4100;
app.listen(PORT, () => {
  console.log(`marketing-tools запущен: http://localhost:${PORT}`);
});
