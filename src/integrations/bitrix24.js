// Bitrix24 REST API через входящий вебхук (https://<domain>.bitrix24.ru/rest/<user>/<code>/)

function normalizeWebhookUrl(url) {
  if (!url) throw new Error('Не задан Bitrix24 webhook URL');
  return url.endsWith('/') ? url : `${url}/`;
}

async function callMethod(webhookUrl, method, params = {}) {
  const url = `${normalizeWebhookUrl(webhookUrl)}${method}.json`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`Bitrix24 (${method}): ${json.error_description || json.error}`);
  }
  return json;
}

async function listAll(webhookUrl, method, params = {}, maxRows = 2000) {
  const all = [];
  let start = 0;
  while (all.length < maxRows) {
    const json = await callMethod(webhookUrl, method, { ...params, start });
    const rows = json.result || [];
    all.push(...rows);
    if (!json.next || rows.length === 0) break;
    start = json.next;
  }
  return all.slice(0, maxRows);
}

async function fetchLeads(webhookUrl, dateFrom, dateTo) {
  return listAll(webhookUrl, 'crm.lead.list', {
    filter: { '>=DATE_CREATE': dateFrom, '<=DATE_CREATE': dateTo },
    select: ['ID', 'TITLE', 'STATUS_ID', 'SOURCE_ID', 'OPPORTUNITY', 'DATE_CREATE', 'ASSIGNED_BY_ID'],
    order: { DATE_CREATE: 'ASC' },
  });
}

async function fetchDeals(webhookUrl, dateFrom, dateTo, categoryIds) {
  const filter = { '>=DATE_CREATE': dateFrom, '<=DATE_CREATE': dateTo };
  if (categoryIds && categoryIds.length) filter.CATEGORY_ID = categoryIds;
  return listAll(webhookUrl, 'crm.deal.list', {
    filter,
    select: ['ID', 'TITLE', 'STAGE_ID', 'CATEGORY_ID', 'OPPORTUNITY', 'CURRENCY_ID', 'DATE_CREATE', 'CLOSED', 'SOURCE_ID'],
    order: { DATE_CREATE: 'ASC' },
  });
}

async function fetchDealStages(webhookUrl, categoryId = 0) {
  try {
    const json = await callMethod(webhookUrl, 'crm.dealcategory.stage.list', { id: categoryId });
    return json.result || [];
  } catch {
    return [];
  }
}

// Список воронок (направлений) сделок — crm.dealcategory.list. Воронка с ID=0 — основная ("Общая воронка/Продажи").
async function fetchFunnels(webhookUrl) {
  const json = await callMethod(webhookUrl, 'crm.dealcategory.list', {});
  const funnels = json.result || [];
  const hasDefault = funnels.some((f) => String(f.ID) === '0');
  if (!hasDefault) funnels.unshift({ ID: '0', NAME: 'Общая воронка (по умолчанию)' });
  return funnels.map((f) => ({ id: String(f.ID), name: f.NAME }));
}

// Список источников лидов/сделок — crm.status.list(ENTITY_ID=SOURCE). Используется и для подписи графиков,
// и чтобы можно было сопоставить конкретные источники с конкретным сайтом (в настройках сайта).
async function fetchSources(webhookUrl) {
  const json = await callMethod(webhookUrl, 'crm.status.list', { filter: { ENTITY_ID: 'SOURCE' } });
  const rows = json.result || [];
  return rows.map((r) => ({ id: String(r.STATUS_ID), name: r.NAME }));
}

function summarizeFunnel(deals, stages, funnelNames, sourceNames = {}) {
  const stageNames = {};
  for (const s of stages) stageNames[s.STATUS_ID] = s.NAME;

  const byStage = {};
  const byFunnel = {};
  const bySource = {};
  let totalAmount = 0;
  let wonAmount = 0;
  let wonCount = 0;
  let lostCount = 0;

  for (const d of deals) {
    const stageKey = d.STAGE_ID || 'UNKNOWN';
    if (!byStage[stageKey]) byStage[stageKey] = { stage: stageNames[stageKey] || stageKey, count: 0, amount: 0 };
    byStage[stageKey].count += 1;
    const amount = parseFloat(d.OPPORTUNITY) || 0;
    byStage[stageKey].amount += amount;
    totalAmount += amount;

    const categoryKey = String(d.CATEGORY_ID ?? '0');
    if (!byFunnel[categoryKey]) byFunnel[categoryKey] = { funnel: (funnelNames && funnelNames[categoryKey]) || `Воронка ${categoryKey}`, count: 0, amount: 0 };
    byFunnel[categoryKey].count += 1;
    byFunnel[categoryKey].amount += amount;

    const sourceKey = String(d.SOURCE_ID || 'UNKNOWN');
    if (!bySource[sourceKey]) bySource[sourceKey] = { source: sourceNames[sourceKey] || sourceKey, count: 0, amount: 0 };
    bySource[sourceKey].count += 1;
    bySource[sourceKey].amount += amount;

    if (/WON/i.test(stageKey)) {
      wonAmount += amount;
      wonCount += 1;
    }
    if (/LOSE|LOST/i.test(stageKey)) lostCount += 1;
  }

  for (const f of Object.values(byFunnel)) f.amount = Math.round(f.amount * 100) / 100;
  for (const s of Object.values(bySource)) s.amount = Math.round(s.amount * 100) / 100;

  return {
    totalDeals: deals.length,
    totalAmount: Math.round(totalAmount * 100) / 100,
    wonCount,
    wonAmount: Math.round(wonAmount * 100) / 100,
    lostCount,
    conversionRate: deals.length ? Math.round((wonCount / deals.length) * 1000) / 10 : 0,
    byStage: Object.values(byStage),
    byFunnel: Object.values(byFunnel),
    bySource: Object.values(bySource),
  };
}

function summarizeLeads(leads, sourceNames = {}) {
  const bySource = {};
  const byStatus = {};
  let convertedCount = 0;
  for (const l of leads) {
    const srcKey = String(l.SOURCE_ID || 'UNKNOWN');
    const status = l.STATUS_ID || 'UNKNOWN';
    if (!bySource[srcKey]) bySource[srcKey] = { source: sourceNames[srcKey] || srcKey, count: 0 };
    bySource[srcKey].count += 1;
    byStatus[status] = (byStatus[status] || 0) + 1;
    // CONVERTED — стандартный статус Bitrix24 для лида, превращённого в сделку/контакт.
    if (status === 'CONVERTED') convertedCount += 1;
  }
  return {
    totalLeads: leads.length,
    convertedCount,
    conversionRate: leads.length ? Math.round((convertedCount / leads.length) * 1000) / 10 : 0,
    bySource: Object.values(bySource),
    byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
  };
}

// Выполняет все запросы к Bitrix24 один раз и возвращает «сырые» данные (сделки/лиды/справочники) —
// из них можно посчитать как общую сводку, так и срез по конкретному сайту (фильтром по SOURCE_ID),
// не делая повторных запросов к API.
async function collectBitrix24Raw({ webhookUrl, dateFrom, dateTo, categoryIds }) {
  const [funnels, sources] = await Promise.all([fetchFunnels(webhookUrl), fetchSources(webhookUrl)]);
  const funnelNames = {};
  for (const f of funnels) funnelNames[f.id] = f.name;
  const sourceNames = {};
  for (const s of sources) sourceNames[s.id] = s.name;

  const relevantCategoryIds = categoryIds && categoryIds.length ? categoryIds : funnels.map((f) => f.id);

  const [leads, deals, stagesPerCategory] = await Promise.all([
    fetchLeads(webhookUrl, dateFrom, dateTo),
    fetchDeals(webhookUrl, dateFrom, dateTo, categoryIds && categoryIds.length ? categoryIds : null),
    Promise.all(relevantCategoryIds.map((id) => fetchDealStages(webhookUrl, id))),
  ]);
  const stages = stagesPerCategory.flat();

  return { leads, deals, stages, funnelNames, sourceNames, relevantCategoryIds };
}

async function collectBitrix24({ webhookUrl, dateFrom, dateTo, categoryIds }) {
  const raw = await collectBitrix24Raw({ webhookUrl, dateFrom, dateTo, categoryIds });
  const leadsSummary = summarizeLeads(raw.leads, raw.sourceNames);
  const funnelSummary = summarizeFunnel(raw.deals, raw.stages, raw.funnelNames, raw.sourceNames);

  return {
    periodFrom: dateFrom,
    periodTo: dateTo,
    funnelsAnalyzed: raw.relevantCategoryIds.map((id) => raw.funnelNames[id] || `Воронка ${id}`),
    leads: leadsSummary,
    funnel: funnelSummary,
    raw: { leadsCount: raw.leads.length, dealsCount: raw.deals.length },
  };
}

module.exports = { collectBitrix24, collectBitrix24Raw, callMethod, fetchFunnels, fetchSources, summarizeLeads, summarizeFunnel };
