const express = require('express');
const { listSites, getSite, createSite, updateSite, deleteSite } = require('../db');
const { invalidateCache } = require('../liveData');

const router = express.Router();

router.get('/', (req, res) => {
  res.json(listSites());
});

router.post('/', (req, res) => {
  const { name, metrikaCounterId, siteOwnUrls, siteSitemapUrl, siteCompetitorUrls, bitrix24SourceIds, metrikaGoalIds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название сайта' });
  const id = createSite({ name: name.trim(), metrikaCounterId, siteOwnUrls, siteSitemapUrl, siteCompetitorUrls, bitrix24SourceIds, metrikaGoalIds });
  invalidateCache();
  res.json(getSite(id));
});

router.put('/:id', (req, res) => {
  const site = getSite(Number(req.params.id));
  if (!site) return res.status(404).json({ error: 'Сайт не найден' });
  const { name, metrikaCounterId, siteOwnUrls, siteSitemapUrl, siteCompetitorUrls, bitrix24SourceIds, metrikaGoalIds } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите название сайта' });
  updateSite(site.id, { name: name.trim(), metrikaCounterId, siteOwnUrls, siteSitemapUrl, siteCompetitorUrls, bitrix24SourceIds, metrikaGoalIds });
  invalidateCache();
  res.json(getSite(site.id));
});

router.delete('/:id', (req, res) => {
  const site = getSite(Number(req.params.id));
  if (!site) return res.status(404).json({ error: 'Сайт не найден' });
  deleteSite(site.id);
  invalidateCache();
  res.json({ ok: true });
});

module.exports = router;
