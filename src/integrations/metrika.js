// Яндекс.Метрика Reporting API — https://api-metrika.yandex.net/stat/v1/data
// Примечание: тепловые карты и Вебвизор не имеют публичного API для выгрузки данных —
// Метрика отдаёт только агрегированные метрики (визиты, глубина просмотра, время на сайте и т.д.).
// Ссылки на карты/вебвизор для ручного просмотра добавляются в отчёт отдельно.

const BASE_URL = 'https://api-metrika.yandex.net/stat/v1/data';
const MANAGEMENT_URL = 'https://api-metrika.yandex.net/management/v1';

async function request(token, params) {
  const url = new URL(BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const res = await fetch(url, { headers: { Authorization: `OAuth ${token}` } });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Яндекс.Метрика: ${json.message || res.statusText}`);
  }
  return json;
}

// Список целей счётчика (Management API) — используется и для выбора целей в настройках сайта,
// и для подписи графиков конверсий человекочитаемыми названиями.
async function fetchGoals(token, counterId) {
  const res = await fetch(`${MANAGEMENT_URL}/counter/${counterId}/goals`, {
    headers: { Authorization: `OAuth ${token}` },
  });
  const json = await res.json();
  if (!res.ok) {
    throw new Error(`Яндекс.Метрика (цели): ${json.message || res.statusText}`);
  }
  return (json.goals || []).map((g) => ({ id: String(g.id), name: g.name }));
}

async function collectMetrika({ token, counterId, dateFrom, dateTo, goalIds }) {
  if (!token) throw new Error('Не задан OAuth-токен Яндекс.Метрики');
  if (!counterId) throw new Error('Не задан ID счётчика Яндекс.Метрики');

  const overall = await request(token, {
    id: counterId,
    date1: dateFrom,
    date2: dateTo,
    metrics: 'ym:s:visits,ym:s:users,ym:s:pageviews,ym:s:bounceRate,ym:s:pageDepth,ym:s:avgVisitDurationSeconds',
  });

  const byDay = await request(token, {
    id: counterId,
    date1: dateFrom,
    date2: dateTo,
    metrics: 'ym:s:visits,ym:s:pageviews,ym:s:bounceRate',
    dimensions: 'ym:s:date',
  });

  const bySource = await request(token, {
    id: counterId,
    date1: dateFrom,
    date2: dateTo,
    metrics: 'ym:s:visits,ym:s:bounceRate,ym:s:pageDepth',
    dimensions: 'ym:s:lastsignTrafficSource',
    sort: '-ym:s:visits',
  });

  const topPages = await request(token, {
    id: counterId,
    date1: dateFrom,
    date2: dateTo,
    metrics: 'ym:pv:pageviews,ym:pv:users',
    dimensions: 'ym:pv:URLPathFull',
    sort: '-ym:pv:pageviews',
    limit: 20,
  });

  const totals = overall.totals || [];
  const [visits, users, pageviews, bounceRate, pageDepth, avgDuration] = totals;

  let goals = [];
  if (goalIds && goalIds.length) {
    const allGoals = await fetchGoals(token, counterId);
    const goalNames = {};
    for (const g of allGoals) goalNames[g.id] = g.name;
    const relevantIds = goalIds.filter((id) => goalNames[id]);

    if (relevantIds.length) {
      const goalMetrics = relevantIds.flatMap((id) => [`ym:s:goal${id}reaches`, `ym:s:goal${id}conversionRate`]);
      const goalsData = await request(token, {
        id: counterId,
        date1: dateFrom,
        date2: dateTo,
        metrics: goalMetrics.join(','),
      });
      const goalTotals = goalsData.totals || [];
      goals = relevantIds.map((id, i) => ({
        id,
        name: goalNames[id],
        reaches: goalTotals[i * 2] || 0,
        conversionRatePct: goalTotals[i * 2 + 1] != null ? Math.round(goalTotals[i * 2 + 1] * 100) / 100 : 0,
      }));
    }
  }

  return {
    periodFrom: dateFrom,
    periodTo: dateTo,
    counterId,
    totals: {
      visits: visits || 0,
      users: users || 0,
      pageviews: pageviews || 0,
      bounceRatePct: bounceRate != null ? Math.round(bounceRate * 10) / 10 : null,
      pageDepth: pageDepth != null ? Math.round(pageDepth * 100) / 100 : null,
      avgVisitDurationSeconds: avgDuration != null ? Math.round(avgDuration) : null,
    },
    byDay: (byDay.data || []).map((row) => ({
      date: row.dimensions[0].name,
      visits: row.metrics[0],
      pageviews: row.metrics[1],
      bounceRatePct: Math.round((row.metrics[2] || 0) * 10) / 10,
    })),
    byTrafficSource: (bySource.data || []).map((row) => ({
      source: row.dimensions[0].name,
      visits: row.metrics[0],
      bounceRatePct: Math.round((row.metrics[1] || 0) * 10) / 10,
      pageDepth: Math.round((row.metrics[2] || 0) * 100) / 100,
    })),
    topPages: (topPages.data || []).map((row) => ({
      url: row.dimensions[0].name,
      pageviews: row.metrics[0],
      users: row.metrics[1],
    })),
    goals,
    note:
      'Данные по тепловым картам и Вебвизору Метрика не выгружает через API — для визуального анализа карт кликов/скроллов и записей сессий используйте интерфейс Метрики вручную (раздел «Карты» и «Вебвизор»).',
  };
}

module.exports = { collectMetrika, fetchGoals };
