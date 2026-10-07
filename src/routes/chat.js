const express = require('express');
const crypto = require('node:crypto');
const { getAllSettings, insertChatMessage, listChatMessages, clearChatMessages } = require('../db');
const { getLiveSnapshot } = require('../liveData');
const { chatWithLiveData } = require('../integrations/openai');

const router = express.Router();

// Сбор живых данных + ответ модели вместе может занимать больше минуты на реальных объёмах CRM —
// держать всё это время один HTTP-запрос открытым ненадёжно (таймауты браузера/прокси дают "Failed to fetch").
// Поэтому POST сразу возвращает jobId и считает в фоне, а клиент опрашивает статус.
const jobs = new Map(); // jobId -> { status: 'pending'|'done'|'error', reply?, error? }
const JOB_TTL_MS = 5 * 60 * 1000;

router.get('/', (req, res) => {
  res.json(listChatMessages());
});

router.delete('/', (req, res) => {
  clearChatMessages();
  res.json({ ok: true });
});

router.post('/', (req, res) => {
  const { message } = req.body || {};
  if (!message || !message.trim()) return res.status(400).json({ error: 'Пустое сообщение' });

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { status: 'pending' });
  res.json({ jobId });

  (async () => {
    try {
      insertChatMessage('user', message.trim());

      const settings = getAllSettings();
      const liveData = await getLiveSnapshot({});
      const history = listChatMessages(20).map((m) => ({ role: m.role, content: m.content }));

      const reply = await chatWithLiveData({
        apiKey: settings.openai_api_key,
        baseUrl: settings.openai_base_url,
        model: settings.openai_model,
        history,
        liveData,
      });

      insertChatMessage('assistant', reply);
      jobs.set(jobId, { status: 'done', reply });
    } catch (err) {
      jobs.set(jobId, { status: 'error', error: err.message });
    } finally {
      setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
    }
  })();
});

router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Задача не найдена или устарела' });
  res.json(job);
});

module.exports = router;
