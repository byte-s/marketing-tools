const SECRET_FIELDS = ['bitrix24_webhook_url', 'metrika_token', 'direct_token', 'openai_api_key', 'pagespeed_api_key'];
const PLAIN_FIELDS = ['direct_login', 'openai_model', 'openai_base_url'];
const CHART_COLORS = ['#0f172a', '#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#64748b'];

// Если сессия истекла (куки очищены/протухли), любой API-вызов вернёт 401 — в этом случае просто
// уводим на страницу входа, не заставляя разбираться с ошибками по всему приложению.
const _origFetch = window.fetch.bind(window);
window.fetch = async (...args) => {
  const res = await _origFetch(...args);
  if (res.status === 401 && typeof args[0] === 'string' && args[0].startsWith('/api/')) {
    window.location.href = '/login';
  }
  return res;
};

$('logout-btn').addEventListener('click', async () => {
  await fetch('/api/auth/logout', { method: 'POST' });
  window.location.href = '/login';
});

$('pw-save').addEventListener('click', async () => {
  const currentPassword = $('pw-current').value;
  const newPassword = $('pw-new').value;
  $('pw-status').textContent = '';
  if (!newPassword || newPassword.length < 8) {
    $('pw-status').textContent = 'Новый пароль должен быть не короче 8 символов';
    $('pw-status').className = 'text-sm text-red-600';
    return;
  }
  try {
    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Ошибка смены пароля');
    $('pw-current').value = '';
    $('pw-new').value = '';
    $('pw-status').textContent = 'Пароль изменён ✓';
    $('pw-status').className = 'text-sm text-green-700';
  } catch (err) {
    $('pw-status').textContent = err.message;
    $('pw-status').className = 'text-sm text-red-600';
  }
});

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('ru-RU');
}

function defaultDates() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

// ---- Настройки ----

let selectedFunnelIds = new Set();

async function loadSettings() {
  const res = await fetch('/api/settings');
  const settings = await res.json();
  for (const key of SECRET_FIELDS) {
    const input = $(key);
    if (!input) continue;
    const info = settings[key];
    if (info && info.set) input.placeholder = `Сохранено: ${info.masked}`;
  }
  for (const key of PLAIN_FIELDS) {
    const input = $(key);
    if (input && settings[key]) input.value = settings[key];
  }
  selectedFunnelIds = new Set(
    String(settings.bitrix24_category_ids || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

function renderFunnelsList(funnels) {
  const container = $('b24-funnels-list');
  if (funnels.length === 0) {
    container.innerHTML = '<p class="text-slate-400 text-xs">Воронки не найдены.</p>';
    return;
  }
  container.innerHTML = funnels
    .map(
      (f) => `
    <label class="flex items-center gap-2">
      <input type="checkbox" value="${f.id}" ${selectedFunnelIds.has(f.id) ? 'checked' : ''} />
      <span>${escapeHtml(f.name)}</span>
    </label>`
    )
    .join('');
}

$('b24-load-funnels').addEventListener('click', async () => {
  const btn = $('b24-load-funnels');
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = 'Загрузка…';
  try {
    const res = await fetch('/api/collect/bitrix24/funnels');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    renderFunnelsList(json);
  } catch (err) {
    $('b24-funnels-list').innerHTML = `<p class="text-red-600 text-xs">Ошибка: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
});

$('save-settings').addEventListener('click', async () => {
  const body = {};
  for (const key of SECRET_FIELDS) {
    const input = $(key);
    if (!input) continue;
    body[key] = input.value.trim() === '' ? '__unchanged__' : input.value.trim();
  }
  for (const key of PLAIN_FIELDS) {
    const input = $(key);
    if (!input) continue;
    body[key] = input.value.trim();
  }
  const funnelCheckboxes = document.querySelectorAll('#b24-funnels-list input[type="checkbox"]');
  if (funnelCheckboxes.length > 0) {
    body.bitrix24_category_ids = [...funnelCheckboxes].filter((cb) => cb.checked).map((cb) => cb.value).join(',');
  }
  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  $('settings-status').textContent = res.ok ? 'Сохранено ✓' : 'Ошибка сохранения';
  setTimeout(() => ($('settings-status').textContent = ''), 3000);
  for (const key of SECRET_FIELDS) if ($(key)) $(key).value = '';
  await loadSettings();
  await fetchSites();
});

// ---- Модалка настроек ----

$('open-settings').addEventListener('click', async () => {
  $('settings-modal').style.display = 'flex';
  await loadSites();
});
$('close-settings').addEventListener('click', () => {
  $('settings-modal').style.display = 'none';
});
$('settings-modal').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') $('settings-modal').style.display = 'none';
});

// ---- Сайты ----

let sitesCache = [];

async function fetchSites() {
  const res = await fetch('/api/sites');
  sitesCache = await res.json();
  return sitesCache;
}

let selectedSiteSourceIds = new Set();

function resetSiteForm() {
  $('site-form-id').value = '';
  $('site-form-name').value = '';
  $('site-form-counter').value = '';
  $('site-form-own-urls').value = '';
  $('site-form-sitemap').value = '';
  $('site-form-competitors').value = '';
  $('site-form-title').textContent = 'Добавить сайт';
  $('site-form-cancel').classList.add('hidden');
  selectedSiteSourceIds = new Set();
  $('site-sources-list').innerHTML = '<p class="text-slate-400 text-xs">Нажмите «Загрузить список источников», чтобы выбрать, какие лиды/сделки Bitrix24 относятся к этому сайту.</p>';
}

function renderSiteSourcesList(sources) {
  const container = $('site-sources-list');
  if (sources.length === 0) {
    container.innerHTML = '<p class="text-slate-400 text-xs">Источники не найдены.</p>';
    return;
  }
  container.innerHTML = sources
    .map(
      (s) => `
    <label class="flex items-center gap-2">
      <input type="checkbox" value="${s.id}" ${selectedSiteSourceIds.has(s.id) ? 'checked' : ''} />
      <span>${escapeHtml(s.name)} <span class="text-slate-400">(${escapeHtml(s.id)})</span></span>
    </label>`
    )
    .join('');
}

$('site-load-sources').addEventListener('click', async () => {
  const btn = $('site-load-sources');
  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = 'Загрузка…';
  try {
    const res = await fetch('/api/collect/bitrix24/sources');
    const json = await res.json();
    if (!res.ok) throw new Error(json.error);
    renderSiteSourcesList(json);
  } catch (err) {
    $('site-sources-list').innerHTML = `<p class="text-red-600 text-xs">Ошибка: ${escapeHtml(err.message)}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
});

async function loadSites() {
  const sites = await fetchSites();
  const container = $('sites-list');
  container.innerHTML = sites.length
    ? sites
        .map(
          (s) => `
      <div class="border border-slate-200 rounded p-3 flex justify-between items-start gap-3">
        <div class="text-sm">
          <div class="font-semibold">${escapeHtml(s.name)}</div>
          <div class="text-slate-500">Счётчик Метрики: ${escapeHtml(s.metrika_counter_id || '—')}</div>
          <div class="text-slate-400 text-xs mt-1 break-words">${escapeHtml(s.site_sitemap_url || s.site_own_urls || 'URL для аудита не заданы')}</div>
        </div>
        <div class="flex gap-2 shrink-0">
          <button class="text-blue-600 underline text-sm" data-edit-site="${s.id}">Изменить</button>
          <button class="text-red-600 underline text-sm" data-delete-site="${s.id}">Удалить</button>
        </div>
      </div>`
        )
        .join('')
    : '<p class="text-sm text-slate-500">Сайтов пока нет — заполните форму ниже, чтобы добавить первый.</p>';

  document.querySelectorAll('[data-edit-site]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const site = sitesCache.find((s) => s.id === Number(btn.dataset.editSite));
      if (!site) return;
      $('site-form-id').value = site.id;
      $('site-form-name').value = site.name;
      $('site-form-counter').value = site.metrika_counter_id || '';
      $('site-form-own-urls').value = site.site_own_urls || '';
      $('site-form-sitemap').value = site.site_sitemap_url || '';
      $('site-form-competitors').value = site.site_competitor_urls || '';
      $('site-form-title').textContent = `Редактирование: ${site.name}`;
      $('site-form-cancel').classList.remove('hidden');
      selectedSiteSourceIds = new Set(String(site.bitrix24_source_ids || '').split(',').map((s) => s.trim()).filter(Boolean));
      $('site-sources-list').innerHTML = selectedSiteSourceIds.size
        ? `<p class="text-slate-500 text-xs">Выбрано источников: ${selectedSiteSourceIds.size}. Нажмите «Загрузить список источников», чтобы изменить.</p>`
        : '<p class="text-slate-400 text-xs">Нажмите «Загрузить список источников», чтобы выбрать, какие лиды/сделки Bitrix24 относятся к этому сайту.</p>';
    })
  );

  document.querySelectorAll('[data-delete-site]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Удалить сайт? Собранная история данных останется, но без привязки к новому сайту.')) return;
      await fetch(`/api/sites/${btn.dataset.deleteSite}`, { method: 'DELETE' });
      await loadSites();
      await loadDashboard();
    })
  );
}

$('site-form-save').addEventListener('click', async () => {
  const id = $('site-form-id').value;
  const payload = {
    name: $('site-form-name').value.trim(),
    metrikaCounterId: $('site-form-counter').value.trim(),
    siteOwnUrls: $('site-form-own-urls').value.trim(),
    siteSitemapUrl: $('site-form-sitemap').value.trim(),
    siteCompetitorUrls: $('site-form-competitors').value.trim(),
  };
  const sourceCheckboxes = document.querySelectorAll('#site-sources-list input[type="checkbox"]');
  if (sourceCheckboxes.length > 0) {
    payload.bitrix24SourceIds = [...sourceCheckboxes].filter((cb) => cb.checked).map((cb) => cb.value).join(',');
  } else if (selectedSiteSourceIds.size > 0) {
    // Список источников не перезагружали в этой сессии — сохраняем то, что уже было выбрано ранее.
    payload.bitrix24SourceIds = [...selectedSiteSourceIds].join(',');
  }
  if (!payload.name) {
    alert('Укажите название сайта');
    return;
  }
  const res = await fetch(id ? `/api/sites/${id}` : '/api/sites', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    alert(json.error || 'Ошибка сохранения сайта');
    return;
  }
  resetSiteForm();
  await loadSites();
  await loadDashboard();
});

$('site-form-cancel').addEventListener('click', resetSiteForm);

// ---- Дашборд ----

const dashCharts = {};

function destroyChart(key) {
  if (dashCharts[key]) {
    dashCharts[key].destroy();
    dashCharts[key] = null;
  }
}

function kpiCard(label, value, sub, variant) {
  const cardClass = variant === 'error' ? 'kpi-card border-red-200 bg-red-50' : variant === 'neutral' ? 'kpi-card border-slate-200 bg-slate-50' : 'kpi-card';
  const valueClass = variant === 'error' ? 'text-sm font-semibold mt-1 text-red-700' : variant === 'neutral' ? 'text-sm font-semibold mt-1 text-slate-500' : 'text-xl font-semibold mt-1';
  const subClass = variant === 'error' ? 'text-xs text-red-500 mt-1 break-words line-clamp-2' : 'text-xs text-slate-400 mt-1 break-words';
  return `<div class="${cardClass}">
    <div class="text-xs text-slate-500">${escapeHtml(label)}</div>
    <div class="${valueClass}">${escapeHtml(String(value))}</div>
    ${sub ? `<div class="${subClass}" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>` : ''}
  </div>`;
}

function renderKpis(json) {
  const cards = [];
  const b = json.bitrix24;
  const d = json.direct;

  if (!b.configured) cards.push(kpiCard('Bitrix24', 'не настроено', 'добавьте webhook в Настройках', 'neutral'));
  else if (!b.ok) cards.push(kpiCard('Bitrix24', 'ошибка запроса', b.error, 'error'));
  else {
    cards.push(kpiCard('Лиды (B24)', fmtNum(b.data.leads.totalLeads), `период: ${json.dateFrom}..${json.dateTo}`));
    cards.push(kpiCard('Конверсия лидов (B24)', `${b.data.leads.conversionRate}%`, `${b.data.leads.convertedCount} из ${b.data.leads.totalLeads} переведены в сделку`));
    cards.push(kpiCard('Сделки выиграно', fmtNum(b.data.funnel.wonCount), `конверсия ${b.data.funnel.conversionRate}%`));
  }

  if (!d.configured) cards.push(kpiCard('Яндекс.Директ', 'не настроено', 'добавьте токен в Настройках', 'neutral'));
  else if (!d.ok) cards.push(kpiCard('Яндекс.Директ', 'ошибка запроса', d.error, 'error'));
  else {
    cards.push(kpiCard('Расход (Директ)', fmtNum(d.data.totals.cost), `CTR ${d.data.totals.ctrPct}%`));
    cards.push(kpiCard('Конверсии (Директ)', fmtNum(d.data.totals.conversions), `цена конверсии ${fmtNum(d.data.totals.costPerConversion)}`));
  }

  for (const site of json.sites) {
    const m = site.metrika;
    if (!m.configured) cards.push(kpiCard(`${site.name}: Метрика`, 'не настроено', 'укажите счётчик в Настройках', 'neutral'));
    else if (!m.ok) cards.push(kpiCard(`${site.name}: Метрика`, 'ошибка запроса', m.error, 'error'));
    else cards.push(kpiCard(`${site.name}: визиты`, fmtNum(m.data.totals.visits), `отказы ${m.data.totals.bounceRatePct ?? '—'}%`));
  }

  $('dash-kpis').innerHTML = cards.join('');
}

function renderDirectCharts(d) {
  ['direct-cost', 'direct-conversions'].forEach(destroyChart);
  if (!d.configured || !d.ok) return;
  const top = [...d.data.campaigns].sort((a, b) => b.cost - a.cost).slice(0, 8);
  const base = { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } } };
  dashCharts['direct-cost'] = new Chart($('chart-direct-cost'), {
    type: 'bar',
    data: { labels: top.map((c) => c.name || c.id), datasets: [{ label: 'Расход', data: top.map((c) => c.cost), backgroundColor: CHART_COLORS[3] }] },
    options: base,
  });
  dashCharts['direct-conversions'] = new Chart($('chart-direct-conversions'), {
    type: 'bar',
    data: { labels: top.map((c) => c.name || c.id), datasets: [{ label: 'Конверсии', data: top.map((c) => c.conversions), backgroundColor: CHART_COLORS[2] }] },
    options: base,
  });
}

function topNWithOther(items, n, labelFn, valueFn) {
  const sorted = [...items].sort((a, b) => valueFn(b) - valueFn(a));
  const top = sorted.slice(0, n).map((it) => ({ label: labelFn(it), value: valueFn(it) }));
  const restSum = sorted.slice(n).reduce((sum, it) => sum + valueFn(it), 0);
  if (restSum > 0) top.push({ label: 'Другие', value: restSum });
  return top;
}

function renderB24Charts(b) {
  ['b24-funnel', 'b24-leads-source', 'b24-deals-source'].forEach(destroyChart);
  if (!b.configured || !b.ok) return;
  const stages = b.data.funnel.byStage;
  dashCharts['b24-funnel'] = new Chart($('chart-b24-funnel'), {
    type: 'bar',
    data: { labels: stages.map((s) => s.stage), datasets: [{ label: 'Сделок', data: stages.map((s) => s.count), backgroundColor: CHART_COLORS[2] }] },
    options: { responsive: true, plugins: { legend: { display: false } } },
  });
  const leadsBySource = topNWithOther(b.data.leads.bySource, 6, (s) => s.source, (s) => s.count);
  dashCharts['b24-leads-source'] = new Chart($('chart-b24-leads-source'), {
    type: 'doughnut',
    data: { labels: leadsBySource.map((s) => s.label), datasets: [{ data: leadsBySource.map((s) => s.value), backgroundColor: CHART_COLORS }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } },
  });
  const dealsBySource = topNWithOther(b.data.funnel.bySource, 6, (s) => s.source, (s) => s.count);
  dashCharts['b24-deals-source'] = new Chart($('chart-b24-deals-source'), {
    type: 'doughnut',
    data: { labels: dealsBySource.map((s) => s.label), datasets: [{ data: dealsBySource.map((s) => s.value), backgroundColor: CHART_COLORS }] },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } },
  });
}

function renderDashSites(sites) {
  const container = $('dash-sites');
  if (sites.length === 0) {
    container.innerHTML = '<p class="text-sm text-slate-500 col-span-2">Сайты не добавлены — добавьте в Настройках.</p>';
    return;
  }
  container.innerHTML = sites
    .map(
      (s) => `
    <div class="card p-3">
      <div class="flex items-center justify-between">
        <h3 class="font-semibold text-sm">${escapeHtml(s.name)}</h3>
        <div class="flex gap-2">
          <button class="text-xs text-blue-600 underline" data-dash-audit="${s.id}">Обновить аудит</button>
          <button class="text-xs text-slate-600 underline" data-site-detail="${s.id}">Подробнее →</button>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-2 mt-2">
        <div><canvas id="chart-dash-visits-${s.id}" height="110"></canvas></div>
        <div><canvas id="chart-dash-sources-${s.id}" height="110"></canvas></div>
        <div id="dash-conv-${s.id}" class="h-full flex flex-col items-center justify-center text-center"></div>
      </div>
      <p id="dash-site-note-${s.id}" class="text-xs text-slate-400 mt-1"></p>
      <div id="dash-site-audit-${s.id}" class="text-sm mt-2 space-y-1"></div>
    </div>`
    )
    .join('');

  for (const s of sites) {
    ['dash-visits', 'dash-sources'].forEach((k) => destroyChart(`${k}-${s.id}`));
    const note = $(`dash-site-note-${s.id}`);
    const notes = [];
    if (!s.metrika.configured) notes.push('Метрика не настроена.');
    else if (!s.metrika.ok) notes.push(`Метрика: ошибка — ${s.metrika.error}`);
    else {
      const m = s.metrika.data;
      dashCharts[`dash-visits-${s.id}`] = new Chart($(`chart-dash-visits-${s.id}`), {
        type: 'line',
        data: { labels: m.byDay.map((r) => r.date), datasets: [{ label: 'Визиты', data: m.byDay.map((r) => r.visits), borderColor: CHART_COLORS[1], tension: 0.25 }] },
        options: { responsive: true, plugins: { legend: { display: false } } },
      });
      dashCharts[`dash-sources-${s.id}`] = new Chart($(`chart-dash-sources-${s.id}`), {
        type: 'doughnut',
        data: { labels: m.byTrafficSource.map((r) => r.source), datasets: [{ data: m.byTrafficSource.map((r) => r.visits), backgroundColor: CHART_COLORS }] },
        options: { responsive: true, plugins: { legend: { display: false } } },
      });
    }

    const convEl = $(`dash-conv-${s.id}`);
    if (!s.crm.configured) {
      notes.push('Источники CRM для сайта не сопоставлены (настройте в разделе «Сайты»).');
      convEl.innerHTML = '<p class="text-xs text-slate-400">CRM не сопоставлен</p>';
    } else if (!s.crm.ok) {
      notes.push(`CRM: ошибка — ${s.crm.error}`);
      convEl.innerHTML = '<p class="text-xs text-red-500">Ошибка CRM</p>';
    } else {
      const conv = s.crm.data.funnel.conversionRate;
      convEl.innerHTML = `
        <div class="text-2xl font-semibold">${conv}%</div>
        <div class="text-xs text-slate-400">конверсия сделок</div>
        <div class="text-xs text-slate-400 mt-1">${s.crm.data.funnel.wonCount} из ${s.crm.data.funnel.totalDeals}</div>
      `;
    }
    note.textContent = notes.join(' ');

    const auditEl = $(`dash-site-audit-${s.id}`);
    if (!s.audit.configured) {
      auditEl.innerHTML = '<p class="text-slate-500">Аудит ещё не запускался.</p>';
    } else {
      const ad = s.audit.data;
      auditEl.innerHTML = `
        <div>Страниц: <b>${ad.pagesCheckedCount}</b> · Ошибок: <b class="${ad.brokenPagesCount ? 'text-red-600' : ''}">${ad.brokenPagesCount}</b> · Каннибализация: <b>${ad.cannibalizationPairsCount}</b></div>
        <div class="text-xs text-slate-400">Обновлено: ${new Date(s.audit.fetchedAt).toLocaleString('ru-RU')}</div>
      `;
    }
  }

  document.querySelectorAll('[data-dash-audit]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Сканируем…';
      try {
        const res = await fetch('/api/collect/site', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ siteId: Number(btn.dataset.dashAudit) }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error);
        await loadDashboard();
      } catch (err) {
        alert(`Ошибка аудита: ${err.message}`);
        btn.disabled = false;
        btn.textContent = 'Обновить аудит';
      }
    })
  );

  document.querySelectorAll('[data-site-detail]').forEach((btn) =>
    btn.addEventListener('click', () => openSiteDetail(Number(btn.dataset.siteDetail)))
  );
}

let dashAutoTimer = null;
let lastDashboardJson = null;

async function loadDashboard() {
  const dateFrom = $('dash-from').value;
  const dateTo = $('dash-to').value;
  const res = await fetch(`/api/dashboard?dateFrom=${dateFrom}&dateTo=${dateTo}`);
  const json = await res.json();
  lastDashboardJson = json;
  renderKpis(json);
  renderDirectCharts(json.direct);
  renderB24Charts(json.bitrix24);
  renderDashSites(json.sites);
  $('dash-updated').textContent = `Обновлено: ${new Date(json.generatedAt).toLocaleTimeString('ru-RU')}`;
  if ($('site-detail-modal').style.display === 'flex' && currentDetailSiteId != null) {
    openSiteDetail(currentDetailSiteId);
  }
}

$('dash-refresh').addEventListener('click', loadDashboard);

$('dash-auto').addEventListener('change', () => {
  if (dashAutoTimer) clearInterval(dashAutoTimer);
  const seconds = Number($('dash-auto').value);
  if (seconds > 0) dashAutoTimer = setInterval(loadDashboard, seconds * 1000);
});

// ---- Детальный дашборд по сайту ----

let currentDetailSiteId = null;

function detailKpiRow() {
  return $('site-detail-kpis');
}

function renderSiteDetailKpis(site) {
  const cards = [];
  if (!site.metrika.configured) cards.push(kpiCard('Визиты', 'не настроено', 'нет счётчика Метрики', 'neutral'));
  else if (!site.metrika.ok) cards.push(kpiCard('Визиты', 'ошибка', site.metrika.error, 'error'));
  else {
    cards.push(kpiCard('Визиты', fmtNum(site.metrika.data.totals.visits), `отказы ${site.metrika.data.totals.bounceRatePct ?? '—'}%`));
    cards.push(kpiCard('Глубина просмотра', site.metrika.data.totals.pageDepth ?? '—', `${site.metrika.data.totals.avgVisitDurationSeconds ?? '—'} сек на сайте`));
  }
  if (!site.crm.configured) cards.push(kpiCard('Лиды (CRM)', 'не сопоставлено', 'выберите источники в «Сайтах»', 'neutral'));
  else if (!site.crm.ok) cards.push(kpiCard('Лиды (CRM)', 'ошибка', site.crm.error, 'error'));
  else {
    cards.push(kpiCard('Лиды (CRM)', fmtNum(site.crm.data.leads.totalLeads)));
    cards.push(kpiCard('Сделки выиграно', fmtNum(site.crm.data.funnel.wonCount), `конверсия ${site.crm.data.funnel.conversionRate}%`));
  }
  if (site.audit.configured) {
    cards.push(kpiCard('Страниц аудита', fmtNum(site.audit.data.pagesCheckedCount), `ошибок: ${site.audit.data.brokenPagesCount}`));
  }
  detailKpiRow().innerHTML = cards.join('');
}

function renderSiteDetailCharts(site) {
  const keys = ['detail-visits', 'detail-traffic-sources', 'detail-top-pages', 'detail-funnel', 'detail-deals-source', 'detail-leads-source'];
  keys.forEach(destroyChart);

  if (site.metrika.configured && site.metrika.ok) {
    const m = site.metrika.data;
    dashCharts['detail-visits'] = new Chart($('detail-chart-visits'), {
      type: 'line',
      data: { labels: m.byDay.map((r) => r.date), datasets: [{ label: 'Визиты', data: m.byDay.map((r) => r.visits), borderColor: CHART_COLORS[1], tension: 0.25 }] },
      options: { responsive: true, plugins: { legend: { display: false } } },
    });
    dashCharts['detail-traffic-sources'] = new Chart($('detail-chart-traffic-sources'), {
      type: 'doughnut',
      data: { labels: m.byTrafficSource.map((r) => r.source), datasets: [{ data: m.byTrafficSource.map((r) => r.visits), backgroundColor: CHART_COLORS }] },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } },
    });
    const topPages = [...m.topPages].slice(0, 10);
    dashCharts['detail-top-pages'] = new Chart($('detail-chart-top-pages'), {
      type: 'bar',
      data: { labels: topPages.map((p) => p.url), datasets: [{ label: 'Просмотры', data: topPages.map((p) => p.pageviews), backgroundColor: CHART_COLORS[1] }] },
      options: { responsive: true, indexAxis: 'y', plugins: { legend: { display: false } } },
    });
  }

  if (site.crm.configured && site.crm.ok) {
    const stages = site.crm.data.funnel.byStage;
    dashCharts['detail-funnel'] = new Chart($('detail-chart-funnel'), {
      type: 'bar',
      data: { labels: stages.map((s) => s.stage), datasets: [{ label: 'Сделок', data: stages.map((s) => s.count), backgroundColor: CHART_COLORS[2] }] },
      options: { responsive: true, plugins: { legend: { display: false } } },
    });
    const dealsBySource = topNWithOther(site.crm.data.funnel.bySource, 8, (x) => x.source, (x) => x.count);
    dashCharts['detail-deals-source'] = new Chart($('detail-chart-deals-source'), {
      type: 'doughnut',
      data: { labels: dealsBySource.map((x) => x.label), datasets: [{ data: dealsBySource.map((x) => x.value), backgroundColor: CHART_COLORS }] },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } },
    });
    const leadsBySource = topNWithOther(site.crm.data.leads.bySource, 8, (x) => x.source, (x) => x.count);
    dashCharts['detail-leads-source'] = new Chart($('detail-chart-leads-source'), {
      type: 'doughnut',
      data: { labels: leadsBySource.map((x) => x.label), datasets: [{ data: leadsBySource.map((x) => x.value), backgroundColor: CHART_COLORS }] },
      options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } },
    });
  }
}

function renderSiteDetailLists(site) {
  const brokenEl = $('detail-broken-pages');
  const cannibEl = $('detail-cannibalization');
  const speedEl = $('detail-speed');

  if (!site.audit.configured) {
    brokenEl.innerHTML = '<p class="text-slate-500">Аудит ещё не запускался.</p>';
    cannibEl.innerHTML = '<p class="text-slate-500">—</p>';
    speedEl.innerHTML = '<p class="text-slate-500">—</p>';
    return;
  }

  const ad = site.audit.data;
  brokenEl.innerHTML = ad.brokenPages.length
    ? ad.brokenPages.map((p) => `<div class="border-b border-slate-100 py-0.5"><span class="text-red-600 font-semibold">${p.statusCode ?? 'ERR'}</span> ${escapeHtml(p.url)}</div>`).join('')
    : '<p class="text-green-700">Страниц с ошибками не найдено.</p>';

  cannibEl.innerHTML = ad.topCannibalizationPairs.length
    ? ad.topCannibalizationPairs
        .map((p) => `<div class="border-b border-slate-100 py-0.5"><b>${Math.round(p.similarity * 100)}%</b> ${escapeHtml(p.pageA)} ↔ ${escapeHtml(p.pageB)}</div>`)
        .join('')
    : '<p class="text-slate-500">Похожих пар не найдено.</p>';

  speedEl.innerHTML = ad.speed.length
    ? ad.speed
        .map(
          (s) =>
            `<div class="border-b border-slate-100 py-0.5">${escapeHtml(s.url)} — ${
              s.performanceScore != null ? `score ${s.performanceScore}` : `нет данных${s.error ? ` (${escapeHtml(s.error)})` : ''}`
            }${s.lcpSeconds != null ? `, LCP ${s.lcpSeconds}s` : ''}</div>`
        )
        .join('')
    : '<p class="text-slate-500">Нет данных по скорости.</p>';
}

function openSiteDetail(siteId) {
  const site = (lastDashboardJson?.sites || []).find((s) => s.id === siteId);
  if (!site) return;
  currentDetailSiteId = siteId;
  $('site-detail-title').textContent = site.name;
  renderSiteDetailKpis(site);
  renderSiteDetailCharts(site);
  renderSiteDetailLists(site);
  $('site-detail-modal').style.display = 'flex';
}

$('close-site-detail').addEventListener('click', () => {
  $('site-detail-modal').style.display = 'none';
  currentDetailSiteId = null;
});
$('site-detail-modal').addEventListener('click', (e) => {
  if (e.target.id === 'site-detail-modal') {
    $('site-detail-modal').style.display = 'none';
    currentDetailSiteId = null;
  }
});

// ---- Чат с ИИ ----

function renderChatMessage(role, content) {
  const wrap = document.createElement('div');
  wrap.className = `chat-bubble ${role}`;
  wrap.textContent = content;
  $('chat-messages').appendChild(wrap);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
}

async function loadChatHistory() {
  const res = await fetch('/api/chat');
  const rows = await res.json();
  $('chat-messages').innerHTML = '';
  if (rows.length === 0) {
    renderChatMessage('assistant', 'Привет! Спросите меня о текущих данных: трафике, лидах, рекламе или результатах SEO-аудита — я отвечу на основе актуального среза.');
    return;
  }
  for (const m of rows) renderChatMessage(m.role, m.content);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Полный ответ (сбор живых данных + генерация) может занимать больше минуты — поэтому POST сразу
// возвращает jobId, а дальше статус опрашивается короткими запросами, чтобы не держать одно
// долгое HTTP-соединение (именно оно обрывалось с ошибкой "Failed to fetch").
async function sendChatMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  renderChatMessage('user', text);
  const btn = $('chat-send');
  btn.disabled = true;
  const thinking = document.createElement('div');
  thinking.className = 'chat-bubble assistant';
  thinking.textContent = 'Думаю… (собираю актуальные данные и жду ответ модели, может занять до пары минут)';
  $('chat-messages').appendChild(thinking);
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;

  try {
    const startRes = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });
    const startJson = await startRes.json();
    if (!startRes.ok) throw new Error(startJson.error || 'Ошибка запроса');

    const maxAttempts = 90; // до ~3 минут при опросе раз в 2 секунды
    let job = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await sleep(2000);
      const statusRes = await fetch(`/api/chat/status/${startJson.jobId}`);
      job = await statusRes.json();
      if (!statusRes.ok) throw new Error(job.error || 'Задача не найдена');
      if (job.status !== 'pending') break;
    }

    thinking.remove();
    if (!job || job.status === 'pending') throw new Error('Не дождались ответа — похоже, обработка идёт необычно долго. Попробуйте ещё раз чуть позже.');
    if (job.status === 'error') throw new Error(job.error);
    renderChatMessage('assistant', job.reply);
  } catch (err) {
    thinking.remove();
    renderChatMessage('error', `Ошибка: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

$('chat-send').addEventListener('click', sendChatMessage);
$('chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage();
  }
});
$('chat-clear').addEventListener('click', async () => {
  if (!confirm('Очистить историю переписки с ИИ?')) return;
  await fetch('/api/chat', { method: 'DELETE' });
  await loadChatHistory();
});

// ---- Инициализация ----

const { from, to } = defaultDates();
$('dash-from').value = from;
$('dash-to').value = to;

loadSettings();
fetchSites();
loadDashboard();
loadChatHistory();
