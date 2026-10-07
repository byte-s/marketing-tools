const { isAdminConfigured } = require('../db');

// Пропускает дальше только авторизованные запросы. API получает 401 JSON, обычные переходы по
// страницам — редирект на /setup (если администратор ещё не создан) или /login.
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }

  return res.redirect(isAdminConfigured() ? '/login' : '/setup');
}

module.exports = { requireAuth };
