const express = require('express');
const { getAllSettings, getCollectedData, insertAnalysis, listAnalyses, getAnalysis } = require('../db');
const { analyzeWithOpenAI } = require('../integrations/openai');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(listAnalyses());
});

router.get('/:id', (req, res) => {
  const row = getAnalysis(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  res.json(row);
});

router.post('/', async (req, res) => {
  try {
    const { dataIds, question } = req.body || {};
    if (!Array.isArray(dataIds) || dataIds.length === 0) {
      return res.status(400).json({ error: 'Укажите хотя бы один набор данных (dataIds)' });
    }
    const datasets = dataIds.map((id) => getCollectedData(Number(id))).filter(Boolean);
    if (datasets.length === 0) return res.status(404).json({ error: 'Данные не найдены' });

    const settings = getAllSettings();
    const result = await analyzeWithOpenAI({
      apiKey: settings.openai_api_key,
      baseUrl: settings.openai_base_url,
      model: settings.openai_model,
      datasets: datasets.map((d) => ({ source: d.source, label: d.label, period: `${d.period_from || ''}..${d.period_to || ''}`, data: d.data })),
      question,
    });

    const id = insertAnalysis({ dataIds, question, result });
    res.json({ id, result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
