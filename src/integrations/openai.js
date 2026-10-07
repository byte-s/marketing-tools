const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

function buildChatCompletionsUrl(baseUrl) {
  const normalized = (baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  return normalized.endsWith('/chat/completions') ? normalized : `${normalized}/chat/completions`;
}

const CHECKLIST = `При анализе данных сайта (источник "site") обязательно оцени по каждому пункту, для которого есть данные:
1. Текст: оригинальность/риск неуникальности (эвристически по структуре и признакам, явно укажи, что это не база плагиата) и вовлекательность текста.
2. UX: удобство по эвристическим признакам (наличие форм, CTA, alt у изображений, viewport для мобильных, длина страницы).
3. Поведенческие метрики: время на сайте, глубина просмотра, отказы (из Метрики). Если в данных есть заметка про тепловые карты/Вебвизор — упомяни ограничение и порекомендуй, что посмотреть вручную.
4. SEO: соответствие title/description/h1 семантике и предполагаемому поисковому интенту страницы.
5. Каннибализация: если есть пары страниц с высоким сходством — укажи их и дай рекомендацию (объединить/разграничить интент).
6. Коды ответа: перечисли страницы с ошибками (не 200) как критичную проблему.
7. Конкурентный анализ: сравни собственные страницы с конкурентами — что есть у конкурентов и чего нет у нас, что вероятно "выстрелило".
8. Посещаемость: оцени динамику и источники трафика.
9. Скорость загрузки: прокомментируй performance score / TTFB / LCP, если есть.
Для данных Bitrix24 ("bitrix24") — разбери воронку лидов и сделок, конверсию, узкие места.
Для данных Яндекс.Директа ("direct") — разбери расход, CTR, цену конверсии по кампаниям, укажи эффективные и неэффективные кампании.
Структурируй ответ заголовками по-русски, используй маркированные списки, в конце дай приоритизированный список рекомендаций (топ-5).`;

async function callChatCompletions({ apiKey, baseUrl, model, messages }) {
  if (!apiKey) throw new Error('Не задан OpenAI API ключ');
  const url = buildChatCompletionsUrl(baseUrl);
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model: model || 'gpt-4o-mini', messages, temperature: 0.4 }),
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`OpenAI (${url}): ${json?.error?.message || res.statusText}`);
  }
  return json?.choices?.[0]?.message?.content || '';
}

async function analyzeWithOpenAI({ apiKey, baseUrl, model, datasets, question }) {
  const systemPrompt = `Ты — маркетинговый аналитик. Тебе передают данные из Bitrix24 (лиды/воронка продаж), Яндекс.Метрики (трафик и поведение), Яндекс.Директа (рекламные кампании) и/или аудита сайта (SEO, каннибализация, коды ответа, скорость, конкуренты). ${CHECKLIST}`;

  const userContent = [
    question ? `Дополнительный вопрос пользователя: ${question}` : null,
    'Данные для анализа (JSON):',
    JSON.stringify(datasets, null, 2),
  ]
    .filter(Boolean)
    .join('\n\n');

  return callChatCompletions({
    apiKey,
    baseUrl,
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
  });
}

async function chatWithLiveData({ apiKey, baseUrl, model, history, liveData }) {
  const instructions = `Ты — маркетинговый AI-аналитик внутри дашборда. У тебя всегда есть свежий снимок данных по Bitrix24 (лиды/воронка), Яндекс.Метрике (трафик и поведение по каждому сайту), Яндекс.Директу (рекламные кампании) и последнему SEO-аудиту каждого сайта. ${CHECKLIST}
Отвечай кратко и по делу на вопросы пользователя, опираясь на данные ниже. Если данных для ответа не хватает (источник не настроен или нет свежего аудита) — явно скажи об этом, не выдумывай цифры. Форматируй ответ markdown-списками, когда это уместно, но не разворачивай полный отчёт по всем пунктам чек-листа, если пользователь спросил про что-то конкретное.`;

  const dataBlock = `${instructions}

Актуальный снимок данных на ${liveData.generatedAt} (период ${liveData.dateFrom}..${liveData.dateTo}), JSON:
${JSON.stringify(liveData, null, 2)}`;

  // Часть OpenAI-совместимых прокси (особенно «character»-сервисы) игнорирует роль system —
  // поэтому данные и инструкции дублируются прямо в последнем сообщении пользователя, а не только в system.
  const messages = [{ role: 'system', content: instructions }, ...history];
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      messages[i] = { role: 'user', content: `${dataBlock}\n\nВопрос пользователя: ${messages[i].content}` };
      break;
    }
  }

  return callChatCompletions({ apiKey, baseUrl, model, messages });
}

module.exports = { analyzeWithOpenAI, chatWithLiveData };
