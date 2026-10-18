// Buddy-018 step 8A: prompts for Creator-led teaching (no Methodist/Examiner).

export const TEACH_SESSION_STRATEGY = 'buddy-teach-session-v1';

/** Soft cap of corpus text injected into one model call. */
export const CORPUS_PROMPT_CHARS = 28_000;

/**
 * @param {Array<{ n?: number, title?: string, text?: string, pageId?: string, status?: string }>} pages
 * @param {number} [maxChars]
 */
export function formatCorpusForPrompt(pages, maxChars = CORPUS_PROMPT_CHARS) {
  const list = Array.isArray(pages) ? pages : [];
  const index = list.map((p, i) => {
    const n = p.n ?? i + 1;
    const title = (p.title || '').trim() || `(без названия)`;
    const chars = (p.text || '').length;
    const st = p.status || 'ok';
    return `${n}. ${title} — ${chars} зн. [${st}]`;
  }).join('\n') || '(страниц ещё нет)';

  const parts = [];
  let used = 0;
  // Prefer later ingested pages (end of corpus) while keeping earlier ones if space.
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const p = list[i];
    const n = p.n ?? i + 1;
    const title = (p.title || '').trim() || `стр. ${n}`;
    const body = String(p.text || '').trim();
    if (!body) continue;
    const block = `### Глава ${n}. ${title}\n${body}`;
    if (used + block.length + 2 > maxChars && parts.length) break;
    if (used + block.length + 2 > maxChars) {
      const room = Math.max(0, maxChars - used - 80);
      parts.unshift(`### Глава ${n}. ${title}\n${body.slice(0, room)}\n…[обрезка]`);
      used = maxChars;
      break;
    }
    parts.unshift(block);
    used += block.length + 2;
  }

  return [
    '## Оглавление корпуса (уже на сервере)',
    index,
    '',
    '## Тексты (окно в промпт; остальное в сессии — Создатель может сослаться на главу)',
    parts.join('\n\n') || '(тексты ещё не загружены)',
  ].join('\n');
}

/**
 * @param {{
 *   corpusTitle?: string,
 *   pages?: object[],
 *   messages?: Array<{ role: string, text: string }>,
 * }} opts
 */
export function buildTeachSessionPrompt({
  corpusTitle = '',
  pages = [],
  messages = [],
} = {}) {
  const corpusBlock = formatCorpusForPrompt(pages);
  const dialogue = (messages || []).map((m) => {
    const who = m.role === 'bi' ? 'Би' : 'Создатель';
    return `${who}: ${m.text}`;
  }).join('\n') || '(пока нет реплик)';

  const system = `Вы — Би в режиме обучения Buddy (${TEACH_SESSION_STRATEGY}).
Собеседник — Создатель (администратор). Это НЕ обычный чат А–Би.

Правила:
1. Учебный корпус уже прочитан сервером и дан ниже. Опирайтесь на него; не говорите, что не можете открыть Notion; не просите вставить тот же текст вручную.
2. Задачи и проверки даёт только Создатель — по одной. Не составляйте сами экзамен из трёх задач и не оценивайте себя рубриками «буква/дух».
3. Допустимы и желательны вопросы на понимание: если формулировка задачи или место в тексте неясны — спросите Создателя кратко и по делу.
4. Когда отвечаете на задачу — опирайтесь на корпус; если не хватает главы в окне текста, скажите какую главу нужно уточнить.
5. Не записывайте «учения» сами и не притворяйтесь, что материал уже «навсегда усвоен» вне этой сессии.
6. Отвечайте по-русски.

Ответьте ТОЛЬКО JSON без markdown:
{"utterance":"реплика Би","kind":"answer|question|other"}
kind=question — уточняющий вопрос Создателю; answer — ответ на задачу/реплику; other — иное (приветствие, уточнение плана).`;

  const user = [
    `Корпус: ${corpusTitle || 'учебные материалы'}`,
    '',
    corpusBlock,
    '',
    'Диалог сессии (Создатель ↔ Би):',
    dialogue,
    '',
    'Сделайте следующий ход Би.',
  ].join('\n');

  return { system, user, strategyVersion: TEACH_SESSION_STRATEGY };
}
