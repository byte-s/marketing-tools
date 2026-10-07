const express = require('express');
const { getAllSettings, insertCollectedData, listCollectedData, getCollectedData, getSite } = require('../db');
const { collectBitrix24, fetchFunnels, fetchSources } = require('../integrations/bitrix24');
const { collectMetrika } = require('../integrations/metrika');
const { collectDirect } = require('../integrations/direct');
const { collectSiteAudit } = require('../integrations/site');

const router = express.Router();

function defaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

router.get('/', (req, res) => {
  res.json(listCollectedData(req.query.source));
});

router.get('/:id', (req, res) => {
  const row = getCollectedData(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'Не найдено' });
  res.json(row);
});

router.get('/bitrix24/funnels', async (req, res) => {
  try {
    const settings = getAllSettings();
    const funnels = await fetchFunnels(settings.bitrix24_webhook_url);
    res.json(funnels);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/bitrix24/sources', async (req, res) => {
  try {
    const settings = getAllSettings();
    const sources = await fetchSources(settings.bitrix24_webhook_url);
    res.json(sources);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/bitrix24', async (req, res) => {
  try {
    const settings = getAllSettings();
    const { dateFrom, dateTo } = { ...defaultDateRange(), ...req.body };
    const categoryIds = settings.bitrix24_category_ids
      ? settings.bitrix24_category_ids.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const data = await collectBitrix24({ webhookUrl: settings.bitrix24_webhook_url, dateFrom, dateTo, categoryIds });
    const id = insertCollectedData({
      source: 'bitrix24',
      label: `Bitrix24 ${dateFrom}..${dateTo}`,
      periodFrom: dateFrom,
      periodTo: dateTo,
      summary: `Лидов: ${data.leads.totalLeads}, сделок: ${data.funnel.totalDeals}, выиграно: ${data.funnel.wonCount}, воронки: ${data.funnelsAnalyzed.join(', ')}`,
      data,
    });
    res.json({ id, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/metrika', async (req, res) => {
  try {
    const settings = getAllSettings();
    const { dateFrom, dateTo, siteId } = { ...defaultDateRange(), ...req.body };

    let counterId = settings.metrika_counter_id;
    let siteName = '';
    if (siteId) {
      const site = getSite(Number(siteId));
      if (!site) return res.status(404).json({ error: 'Сайт не найден' });
      counterId = site.metrika_counter_id;
      siteName = site.name;
    }

    const data = await collectMetrika({ token: settings.metrika_token, counterId, dateFrom, dateTo });
    const id = insertCollectedData({
      source: 'metrika',
      label: `Метрика${siteName ? ` [${siteName}]` : ''} ${dateFrom}..${dateTo}`,
      periodFrom: dateFrom,
      periodTo: dateTo,
      summary: `Визитов: ${data.totals.visits}, отказы: ${data.totals.bounceRatePct}%`,
      data,
      siteId: siteId ? Number(siteId) : null,
    });
    res.json({ id, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/direct', async (req, res) => {
  try {
    const settings = getAllSettings();
    const { dateFrom, dateTo } = { ...defaultDateRange(), ...req.body };
    const data = await collectDirect({
      token: settings.direct_token,
      login: settings.direct_login,
      dateFrom,
      dateTo,
    });
    const id = insertCollectedData({
      source: 'direct',
      label: `Директ ${dateFrom}..${dateTo}`,
      periodFrom: dateFrom,
      periodTo: dateTo,
      summary: `Расход: ${data.totals.cost}, клики: ${data.totals.clicks}, конверсии: ${data.totals.conversions}`,
      data,
    });
    res.json({ id, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/site', async (req, res) => {
  try {
    const settings = getAllSettings();
    const { siteId } = req.body || {};

    let ownUrls = settings.site_own_urls;
    let sitemapUrl = settings.site_sitemap_url;
    let competitorUrls = settings.site_competitor_urls;
    let siteName = '';
    if (siteId) {
      const site = getSite(Number(siteId));
      if (!site) return res.status(404).json({ error: 'Сайт не найден' });
      ownUrls = site.site_own_urls;
      sitemapUrl = site.site_sitemap_url;
      competitorUrls = site.site_competitor_urls;
      siteName = site.name;
    }

    const data = await collectSiteAudit({ ownUrls, sitemapUrl, competitorUrls, pagespeedApiKey: settings.pagespeed_api_key });
    const id = insertCollectedData({
      source: 'site',
      label: `Аудит сайта${siteName ? ` [${siteName}]` : ''} ${new Date().toISOString().slice(0, 10)}`,
      summary: `Страниц: ${data.ownPages.length}, ошибок: ${data.brokenPages.length}, конкурентов: ${data.competitorPages.length}`,
      data,
      siteId: siteId ? Number(siteId) : null,
    });
    res.json({ id, data });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
