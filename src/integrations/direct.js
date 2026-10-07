// Яндекс.Директ API v5, Reports — https://api.direct.yandex.com/json/v5/reports

const BASE_URL = 'https://api.direct.yandex.com/json/v5/reports';

function formatDirectError(rawText) {
  try {
    const json = JSON.parse(rawText);
    const e = json.error;
    if (e) {
      return [e.error_string, e.error_detail].filter(Boolean).join(' — ') + (e.error_code ? ` (код ${e.error_code})` : '');
    }
  } catch {
    // ответ не JSON — отдаём как есть, но коротко
  }
  return rawText.slice(0, 200);
}

function parseTsv(text) {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.length > 0);
  // Первая строка — название отчёта, последняя(ие) — итоги/служебные строки без табуляции в нужном количестве.
  const headerIndex = lines.findIndex((l) => l.includes('\t'));
  if (headerIndex === -1) return [];
  const headers = lines[headerIndex].split('\t');
  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (cols.length !== headers.length) continue;
    const row = {};
    headers.forEach((h, idx) => (row[h] = cols[idx]));
    rows.push(row);
  }
  return rows;
}

async function requestReport({ token, login, dateFrom, dateTo }) {
  const body = {
    params: {
      SelectionCriteria: { DateFrom: dateFrom, DateTo: dateTo },
      FieldNames: ['CampaignName', 'CampaignId', 'Impressions', 'Clicks', 'Cost', 'AvgCpc', 'Ctr', 'Conversions', 'CostPerConversion'],
      ReportName: `marketing-tools-${Date.now()}`,
      ReportType: 'CAMPAIGN_PERFORMANCE_REPORT',
      DateRangeType: 'CUSTOM_DATE',
      Format: 'TSV',
      IncludeVAT: 'YES',
      IncludeDiscount: 'NO',
    },
  };

  const headers = {
    Authorization: `Bearer ${token}`,
    'Accept-Language': 'ru',
    processingMode: 'auto',
    'Content-Type': 'application/json; charset=utf-8',
    returnMoneyInMicros: 'false',
    skipReportHeader: 'true',
    skipColumnHeader: 'false',
    skipReportSummary: 'true',
  };
  if (login) headers['Client-Login'] = login;

  let attempts = 0;
  while (attempts < 10) {
    const res = await fetch(BASE_URL, { method: 'POST', headers, body: JSON.stringify(body) });
    if (res.status === 201 || res.status === 202) {
      attempts += 1;
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Яндекс.Директ: ${formatDirectError(text)}`);
    }
    return text;
  }
  throw new Error('Яндекс.Директ: отчёт не готов, превышено число попыток');
}

async function collectDirect({ token, login, dateFrom, dateTo }) {
  if (!token) throw new Error('Не задан OAuth-токен Яндекс.Директа');

  const tsv = await requestReport({ token, login, dateFrom, dateTo });
  const rows = parseTsv(tsv);

  const campaigns = rows.map((r) => ({
    name: r.CampaignName,
    id: r.CampaignId,
    impressions: Number(r.Impressions) || 0,
    clicks: Number(r.Clicks) || 0,
    cost: Number(r.Cost) || 0,
    avgCpc: Number(r.AvgCpc) || 0,
    ctrPct: Number(r.Ctr) || 0,
    conversions: Number(r.Conversions) || 0,
    costPerConversion: Number(r.CostPerConversion) || 0,
  }));

  const totals = campaigns.reduce(
    (acc, c) => {
      acc.impressions += c.impressions;
      acc.clicks += c.clicks;
      acc.cost += c.cost;
      acc.conversions += c.conversions;
      return acc;
    },
    { impressions: 0, clicks: 0, cost: 0, conversions: 0 }
  );
  totals.ctrPct = totals.impressions ? Math.round((totals.clicks / totals.impressions) * 1000) / 10 : 0;
  totals.avgCpc = totals.clicks ? Math.round((totals.cost / totals.clicks) * 100) / 100 : 0;
  totals.costPerConversion = totals.conversions ? Math.round((totals.cost / totals.conversions) * 100) / 100 : 0;

  return {
    periodFrom: dateFrom,
    periodTo: dateTo,
    totals,
    campaigns,
  };
}

module.exports = { collectDirect };
