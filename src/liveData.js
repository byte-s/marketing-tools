// Общий сборщик «живых» данных по всем источникам — используется и дашбордом, и AI-чатом,
// чтобы у обоих всегда была одна и та же актуальная картина без дублирования запросов к API.
const { getAllSettings, getLatestCollectedData, listSites } = require('./db');
const { collectBitrix24Raw, summarizeLeads, summarizeFunnel } = require('./integrations/bitrix24');
const { collectMetrika } = require('./integrations/metrika');
const { collectDirect } = require('./integrations/direct');

class NotConfiguredError extends Error {}

// Полный отчёт аудита (с текстами страниц и всеми парами каннибализации) может весить мегабайты —
// это слишком много и для ответа дашборда, и особенно для контекста чат-модели. Отдаём сводку:
// счётчики + топ проблемных пар + выборку страниц без полного текста.
function summarizeAudit(data) {
  const topCannibalization = [...data.cannibalization].sort((a, b) => b.similarity - a.similarity).slice(0, 15);
  const trimPage = (p) => ({
    url: p.url,
    statusCode: p.statusCode,
    title: p.title,
    metaDescription: p.metaDescription,
    h1: p.h1,
    wordCount: p.wordCount,
  });
  return {
    pagesCheckedCount: data.ownPages.length,
    brokenPages: data.brokenPages.slice(0, 30),
    brokenPagesCount: data.brokenPages.length,
    cannibalizationPairsCount: data.cannibalization.length,
    topCannibalizationPairs: topCannibalization,
    competitorPagesCheckedCount: data.competitorPages.length,
    speed: data.speed,
    pagesSample: data.ownPages.slice(0, 20).map(trimPage),
    competitorPagesSample: data.competitorPages.slice(0, 10).map(trimPage),
  };
}

function defaultRange(days = 7) {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { dateFrom: fmt(from), dateTo: fmt(to) };
}

function packResult(result) {
  if (result.status === 'fulfilled') {
    return { ok: true, configured: true, data: result.value };
  }
  if (result.reason instanceof NotConfiguredError) {
    return { ok: false, configured: false, error: null };
  }
  return { ok: false, configured: true, error: result.reason.message };
}

function filterBySource(items, sourceIdSet) {
  return items.filter((it) => sourceIdSet.has(String(it.SOURCE_ID || 'UNKNOWN')));
}

// Сбор живого снимка — это десятки последовательных запросов к Bitrix24/Метрике (особенно постраничная
// выгрузка сделок/лидов), на реальных объёмах может занимать больше минуты. Кэшируем на короткое время,
// чтобы дашборд и чат, обращающиеся почти одновременно, не запускали этот сбор параллельно и заново —
// кэшируется именно промис, а не результат, чтобы конкурентные запросы дождались одного и того же вызова.
const CACHE_TTL_MS = 60 * 1000;
let cache = null; // { key, expiresAt, promise }

// Вызывается при изменении сайтов/настроек, чтобы следующий запрос дашборда/чата не отдал
// устаревший снимок (например, только что добавленную цель Метрики или сайт).
function invalidateCache() {
  cache = null;
}

async function getLiveSnapshot({ dateFrom, dateTo } = {}) {
  const defaults = defaultRange(7);
  dateFrom = dateFrom || defaults.dateFrom;
  dateTo = dateTo || defaults.dateTo;

  const key = `${dateFrom}|${dateTo}`;
  const now = Date.now();
  if (cache && cache.key === key && cache.expiresAt > now) {
    return cache.promise;
  }

  const promise = computeLiveSnapshot(dateFrom, dateTo);
  cache = { key, expiresAt: now + CACHE_TTL_MS, promise };
  try {
    return await promise;
  } catch (err) {
    cache = null; // ошибку не кэшируем — следующий запрос должен попробовать заново
    throw err;
  }
}

async function computeLiveSnapshot(dateFrom, dateTo) {
  const settings = getAllSettings();
  const sites = listSites();

  const categoryIds = settings.bitrix24_category_ids
    ? settings.bitrix24_category_ids.split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const [b24Raw, direct, ...perSiteMetrika] = await Promise.allSettled([
    settings.bitrix24_webhook_url
      ? collectBitrix24Raw({ webhookUrl: settings.bitrix24_webhook_url, dateFrom, dateTo, categoryIds })
      : Promise.reject(new NotConfiguredError()),
    settings.direct_token
      ? collectDirect({ token: settings.direct_token, login: settings.direct_login, dateFrom, dateTo })
      : Promise.reject(new NotConfiguredError()),
    ...sites.map((site) => {
      const goalIds = String(site.metrika_goal_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
      return site.metrika_counter_id && settings.metrika_token
        ? collectMetrika({ token: settings.metrika_token, counterId: site.metrika_counter_id, dateFrom, dateTo, goalIds })
        : Promise.reject(new NotConfiguredError());
    }),
  ]);

  const raw = b24Raw.status === 'fulfilled' ? b24Raw.value : null;

  const bitrix24Packed = raw
    ? {
        ok: true,
        configured: true,
        data: {
          periodFrom: dateFrom,
          periodTo: dateTo,
          funnelsAnalyzed: raw.relevantCategoryIds.map((id) => raw.funnelNames[id] || `Воронка ${id}`),
          leads: summarizeLeads(raw.leads, raw.sourceNames),
          funnel: summarizeFunnel(raw.deals, raw.stages, raw.funnelNames, raw.sourceNames),
        },
      }
    : b24Raw.reason instanceof NotConfiguredError
    ? { ok: false, configured: false, error: null }
    : { ok: false, configured: true, error: b24Raw.reason.message };

  const siteResults = sites.map((site, i) => {
    const latestAudit = getLatestCollectedData('site', site.id);

    let crm = { ok: false, configured: false };
    const sourceIds = String(site.bitrix24_source_ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (sourceIds.length && raw) {
      const sourceSet = new Set(sourceIds);
      const siteLeads = filterBySource(raw.leads, sourceSet);
      const siteDeals = filterBySource(raw.deals, sourceSet);
      crm = {
        ok: true,
        configured: true,
        data: {
          leads: summarizeLeads(siteLeads, raw.sourceNames),
          funnel: summarizeFunnel(siteDeals, raw.stages, raw.funnelNames, raw.sourceNames),
        },
      };
    } else if (sourceIds.length && !raw && b24Raw.status === 'rejected' && !(b24Raw.reason instanceof NotConfiguredError)) {
      crm = { ok: false, configured: true, error: b24Raw.reason.message };
    }

    return {
      id: site.id,
      name: site.name,
      metrika: packResult(perSiteMetrika[i]),
      audit: latestAudit
        ? { ok: true, configured: true, fetchedAt: latestAudit.fetched_at, data: summarizeAudit(latestAudit.data) }
        : { ok: false, configured: false },
      crm,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    dateFrom,
    dateTo,
    bitrix24: bitrix24Packed,
    direct: packResult(direct),
    sites: siteResults,
  };
}

module.exports = { getLiveSnapshot, invalidateCache };
