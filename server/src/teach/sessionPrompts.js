// Buddy-018 step 8A: Creator-led teaching — Bi may search the full canon while learning.

export const TEACH_SESSION_STRATEGY = 'buddy-teach-session-v1';
export const CORPUS_SEARCH_CHARS = 24_000;
export const TEACH_SEARCH_ROUNDS_MAX = 3;
const CHUNK_SIZE = 1_200;
const CHUNK_OVERLAP = 150;

function pageLabel(p, i) {
  return (p.title || p.filename || '').trim() || `стр. ${p.n ?? i + 1}`;
}

function pageChars(p) {
  if (typeof p.charCount === 'number' && p.charCount > 0) return p.charCount;
  return String(p.text || '').length;
}

export function tokenizeQuery(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-zа-яё0-9_]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

export function chunkPage(page, index = 0) {
  const body = String(page.text || '');
  const title = pageLabel(page, index);
  const pageN = page.n ?? index + 1;
  if (!body.trim()) return [];
  if (body.length <= CHUNK_SIZE) {
    return [{ pageN, title, start: 0, text: body.trim() }];
  }
  const out = [];
  let start = 0;
  while (start < body.length) {
    const end = Math.min(body.length, start + CHUNK_SIZE);
    out.push({ pageN, title, start, text: body.slice(start, end).trim() });
    if (end >= body.length) break;
    start = Math.max(0, end - CHUNK_OVERLAP);
  }
  return out;
}

function scoreChunk(chunk, tokens) {
  if (!tokens.length) return 0;
  const hay = chunk.text.toLowerCase();
  const title = chunk.title.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (title.includes(t)) score += 5;
    let from = 0;
    let hits = 0;
    while (hits < 8) {
      const at = hay.indexOf(t, from);
      if (at < 0) break;
      hits += 1;
      from = at + t.length;
    }
    if (hits) score += 3 + hits;
  }
  return score;
}

/** Lexical search over all corpus pages (used when Bi asks to search). */
export function searchCorpusExcerpts(pages, queryText, maxChars = CORPUS_SEARCH_CHARS) {
  const list = Array.isArray(pages) ? pages : [];
  const tokens = tokenizeQuery(queryText);
  const allChunks = [];
  for (let i = 0; i < list.length; i += 1) {
    for (const ch of chunkPage(list[i], i)) {
      allChunks.push({ ...ch, score: scoreChunk(ch, tokens) });
    }
  }
  let ranked = tokens.length
    ? allChunks.filter((c) => c.score > 0).sort((a, b) => b.score - a.score || a.pageN - b.pageN || a.start - b.start)
    : [];
  if (!ranked.length) {
    ranked = allChunks.filter((c) => c.start === 0).sort((a, b) => a.pageN - b.pageN);
  }

  const parts = [];
  const sources = new Set();
  let used = 0;
  for (const ch of ranked) {
    const block = `### Фрагмент · гл. ${ch.pageN} «${ch.title}» (с ${ch.start})\n${ch.text}`;
    if (used + block.length + 2 > maxChars && parts.length) break;
    if (used + block.length + 2 > maxChars) {
      const room = Math.max(0, maxChars - used - 100);
      parts.push(`### Фрагмент · гл. ${ch.pageN} «${ch.title}» (с ${ch.start})\n${ch.text.slice(0, room)}\n…[обрезка]`);
      sources.add(ch.pageN);
      break;
    }
    parts.push(block);
    sources.add(ch.pageN);
    used += block.length + 2;
  }
  return {
    parts,
    sourcePages: [...sources].sort((a, b) => a - b),
    chunkCount: parts.length,
    queryTokens: tokens,
    text: parts.join('\n\n') || '(по запросу ничего не найдено)',
  };
}

/** Catalog only — no silent body injection. */
export function formatCorpusCatalog(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const index = list.map((p, i) => {
    const n = p.n ?? i + 1;
    const title = pageLabel(p, i);
    const chars = pageChars(p);
    const st = p.status || 'ok';
    return `${n}. ${title} — ${chars} зн. [${st}]`;
  }).join('\n') || '(страниц ещё нет)';
  return [
    '## Оглавление Канона (все файлы на сервере; полный текст доступен через ваш поиск)',
    index,
  ].join('\n');
}

/** @deprecated name kept for tests — catalog + optional already-fetched search pack */
export function formatCorpusForPrompt(pages, _ignoredQuery = '', searchPack = null) {
  const cat = formatCorpusCatalog(pages);
  if (!searchPack?.text) return cat;
  return [
    cat,
    '',
    '## Результат вашего поиска по Канону (вы запросили; это не автоподстановка)',
    `Запрос: ${searchPack.query || '—'}`,
    `Главы в выдаче: ${(searchPack.sourcePages || []).join(', ') || '—'}`,
    searchPack.text,
  ].join('\n');
}

/**
 * @param {{
 *   corpusTitle?: string,
 *   pages?: object[],
 *   messages?: Array<{ role: string, text: string }>,
 *   searchPack?: { query: string, text: string, sourcePages?: number[] } | null,
 *   searchRoundsLeft?: number,
 *   forceReply?: boolean,
 * }} opts
 */
export function buildTeachSessionPrompt({
  corpusTitle = '',
  pages = [],
  messages = [],
  searchPack = null,
  searchRoundsLeft = TEACH_SEARCH_ROUNDS_MAX,
  forceReply = false,
} = {}) {
  const corpusBlock = formatCorpusForPrompt(pages, '', searchPack);
  const dialogue = (messages || [])
    .filter((m) => m.role === 'creator' || m.role === 'bi')
    .map((m) => {
      const who = m.role === 'bi' ? 'Би' : 'Создатель';
      return `${who}: ${m.text}`;
    }).join('\n') || '(пока нет реплик)';

  const searchRule = forceReply
    ? `Сейчас поиск больше недоступен (лимит раундов). Ответьте Создателю: action=reply.`
    : `Чтобы опереться на Канон в обучении, сначала ищите по всему корпусу:
{"action":"search","queries":["запрос1","запрос2"]}
Сервер выполнит поиск по текстам всех файлов и вернёт фрагменты. Можно до ${searchRoundsLeft} поиск(ов) в этом ходе, затем обязателен ответ Создателю.
Не просите Создателя «прислать главу» — ищите сами.`;

  const system = `Вы — Би в режиме обучения Buddy (${TEACH_SESSION_STRATEGY}).
Собеседник — Создатель. Это учебная сессия, не обычный чат А–Би.

Роль: ученик. Создатель даёт задачи по одной; вы отвечаете или уточняете. Полный Канон (все загруженные файлы) у вас как библиотека: вы сами ищете по нему в ходе работы над задачей.

Правила:
1. ${searchRule}
2. Когда готовы ответить или спросить Создателя:
{"action":"reply","kind":"answer|question|other","utterance":"…"}
3. Не составляйте автоэкзамен и не оценивайте себя рубриками «буква/дух».
4. Не подменяйте Канон своими предварительными лестницами, если поиск дал опору — используйте найденное.
5. Не записывайте «учения» сами. По-русски.

Ответьте ТОЛЬКО JSON без markdown.`;

  const user = [
    `Корпус: ${corpusTitle || 'учебные материалы'}`,
    '',
    corpusBlock,
    '',
    'Диалог сессии (Создатель ↔ Би):',
    dialogue,
    '',
    forceReply ? 'Сделайте action=reply.' : 'Сделайте ход: search по Канону и/или reply Создателю.',
  ].join('\n');

  return { system, user, strategyVersion: TEACH_SESSION_STRATEGY };
}

export function parseTeachModelAction(raw) {
  const action = String(raw?.action || '').toLowerCase();
  if (action === 'search') {
    const queries = Array.isArray(raw.queries)
      ? raw.queries.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 5)
      : [];
    if (!queries.length && typeof raw.query === 'string' && raw.query.trim()) {
      queries.push(raw.query.trim());
    }
    return { action: 'search', queries };
  }
  // Backward-compatible: kind without action → reply
  const kind = ['answer', 'question', 'other', 'search'].includes(raw?.kind) ? raw.kind : 'other';
  if (kind === 'search') {
    const queries = Array.isArray(raw.queries)
      ? raw.queries.map((q) => String(q || '').trim()).filter(Boolean).slice(0, 5)
      : [];
    return { action: 'search', queries };
  }
  const utterance = typeof raw?.utterance === 'string' ? raw.utterance.trim() : '';
  return { action: 'reply', kind, utterance };
}
