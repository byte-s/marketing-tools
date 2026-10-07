// Краулер сайта: статус-коды, базовое SEO (title/description/h1), скорость ответа,
// текст страницы (для оценки вовлечения/оригинальности через OpenAI), каннибализация ключей.
const cheerio = require('cheerio');

async function fetchSitemapUrls(sitemapUrl, maxUrls = 100) {
  const res = await fetch(sitemapUrl);
  if (!res.ok) throw new Error(`Не удалось загрузить sitemap: ${res.status}`);
  const xml = await res.text();
  const locs = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);

  // Если это sitemap-индекс (ссылки на другие sitemap.xml), подгружаем вложенные (один уровень).
  const nested = locs.filter((u) => /sitemap.*\.xml(\.gz)?$/i.test(u) && u !== sitemapUrl);
  if (nested.length > 0 && nested.length === locs.length) {
    const all = [];
    for (const nestedUrl of nested.slice(0, 5)) {
      try {
        const sub = await fetchSitemapUrls(nestedUrl, maxUrls);
        all.push(...sub);
      } catch {
        // игнорируем проблемный вложенный sitemap
      }
      if (all.length >= maxUrls) break;
    }
    return all.slice(0, maxUrls);
  }
  return locs.slice(0, maxUrls);
}

function parseUrlList(text) {
  return String(text || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function crawlPage(url) {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow' });
    const responseTimeMs = Date.now() - startedAt;
    const html = await res.text();
    const $ = cheerio.load(html);

    const title = $('title').first().text().trim();
    const metaDescription = $('meta[name="description"]').attr('content') || '';
    const h1List = $('h1').map((_, el) => $(el).text().trim()).get();
    const canonical = $('link[rel="canonical"]').attr('href') || '';
    const robotsMeta = $('meta[name="robots"]').attr('content') || '';
    const viewportMeta = $('meta[name="viewport"]').attr('content') || '';
    const hasForm = $('form').length > 0;
    const ctaButtons = $('button, a.btn, [class*="btn"], [class*="button"]').length;
    const imagesTotal = $('img').length;
    const imagesWithoutAlt = $('img').filter((_, el) => !$(el).attr('alt')).length;
    const linksTotal = $('a[href]').length;

    $('script, style, noscript').remove();
    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const wordCount = bodyText ? bodyText.split(' ').length : 0;

    return {
      url,
      statusCode: res.status,
      ok: res.ok,
      responseTimeMs,
      title,
      metaDescription,
      h1: h1List,
      canonical,
      robotsMeta,
      viewportMeta,
      hasForm,
      ctaButtons,
      imagesTotal,
      imagesWithoutAlt,
      linksTotal,
      wordCount,
      textExcerpt: bodyText.slice(0, 3000),
    };
  } catch (err) {
    return {
      url,
      statusCode: null,
      ok: false,
      responseTimeMs: Date.now() - startedAt,
      error: err.message,
    };
  }
}

async function crawlUrls(urls, concurrency = 4) {
  const results = [];
  let index = 0;
  async function worker() {
    while (index < urls.length) {
      const i = index++;
      results[i] = await crawlPage(urls[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  return results;
}

async function checkPageSpeed(url, apiKey) {
  try {
    const endpoint = new URL('https://www.googleapis.com/pagespeedonline/v5/runPagespeed');
    endpoint.searchParams.set('url', url);
    endpoint.searchParams.set('strategy', 'mobile');
    endpoint.searchParams.set('category', 'PERFORMANCE');
    if (apiKey) endpoint.searchParams.set('key', apiKey);
    const res = await fetch(endpoint);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || res.statusText);
    const score = json.lighthouseResult?.categories?.performance?.score;
    const metrics = json.lighthouseResult?.audits || {};
    return {
      url,
      performanceScore: score != null ? Math.round(score * 100) : null,
      lcpSeconds: metrics['largest-contentful-paint']?.numericValue
        ? Math.round(metrics['largest-contentful-paint'].numericValue) / 1000
        : null,
      ttfbMs: metrics['server-response-time']?.numericValue ?? null,
    };
  } catch (err) {
    return { url, performanceScore: null, error: err.message };
  }
}

function wordSet(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/gi, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
}

function jaccardSimilarity(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function detectCannibalization(pages, threshold = 0.5) {
  const valid = pages.filter((p) => p.ok && (p.title || p.textExcerpt));
  const rawSets = valid.map((p) => wordSet(`${p.title} ${p.h1?.join(' ') || ''} ${p.textExcerpt || ''}`));

  // Слова, встречающиеся почти на всех страницах (шапка/меню/футер), убираем перед сравнением —
  // иначе общий шаблон сайта даёт ложное сходство между никак не связанными по теме страницами.
  const docFreq = new Map();
  for (const set of rawSets) for (const w of set) docFreq.set(w, (docFreq.get(w) || 0) + 1);
  const boilerplateThreshold = Math.max(3, Math.ceil(rawSets.length * 0.6));
  const boilerplate = new Set([...docFreq.entries()].filter(([, count]) => count >= boilerplateThreshold).map(([w]) => w));
  const sets = rawSets.map((set) => new Set([...set].filter((w) => !boilerplate.has(w))));

  const pairs = [];
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const sim = jaccardSimilarity(sets[i], sets[j]);
      if (sim >= threshold) {
        pairs.push({
          pageA: valid[i].url,
          pageB: valid[j].url,
          similarity: Math.round(sim * 100) / 100,
        });
      }
    }
  }
  return pairs.sort((a, b) => b.similarity - a.similarity);
}

async function collectSiteAudit({ ownUrls, sitemapUrl, competitorUrls, pagespeedApiKey }) {
  let own = parseUrlList(ownUrls);
  if (sitemapUrl) {
    const fromSitemap = await fetchSitemapUrls(sitemapUrl);
    own = [...new Set([...own, ...fromSitemap])];
  }
  const competitors = parseUrlList(competitorUrls);

  if (own.length === 0) throw new Error('Не задано ни одного URL собственного сайта (список URL или sitemap)');

  const ownPages = await crawlUrls(own, 4);
  const competitorPages = competitors.length ? await crawlUrls(competitors, 4) : [];

  const brokenPages = ownPages.filter((p) => !p.ok).map((p) => ({ url: p.url, statusCode: p.statusCode, error: p.error }));
  const cannibalization = detectCannibalization(ownPages);

  const speedSample = ownPages.filter((p) => p.ok).slice(0, 5);
  const speed = [];
  for (const p of speedSample) {
    speed.push(await checkPageSpeed(p.url, pagespeedApiKey));
  }

  return {
    ownPages: ownPages.map(({ textExcerpt, ...rest }) => ({ ...rest, textExcerpt: textExcerpt?.slice(0, 1200) })),
    competitorPages: competitorPages.map(({ textExcerpt, ...rest }) => ({ ...rest, textExcerpt: textExcerpt?.slice(0, 1200) })),
    brokenPages,
    cannibalization,
    speed,
  };
}

module.exports = { collectSiteAudit, fetchSitemapUrls, crawlPage };
