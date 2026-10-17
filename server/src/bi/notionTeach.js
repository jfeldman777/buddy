// Buddy-018 step 2: when Creator (admin) pastes a Notion URL in chat,
// load the page server-side and hand Markdown to Bi. Long docs → portions («дальше»).
import { HttpError } from '../http.js';
import { findNotionPageRef, readNotionPage } from '../notion/readPage.js';

/** Soft cap per chat turn (chars). Rest comes on «дальше» / «часть N». */
export const NOTION_TEACH_TEXT_MAX = 24_000;

// No \b — in JS word boundaries don't treat Cyrillic as word chars.
const CONTINUE_RE = /(дальше|продолжи|продолжение|ещё|еще|следующ(?:ая|ий|ее|ую)?(?:\s+часть)?)/i;
const PORTION_RE = /(?:часть|порция)\s*(\d+)/i;

/**
 * Prefer URL in the current turn; else look in recent user lines of today's transcript.
 * @returns {{ pageId: string, sourceUrl: string } | null}
 */
export function findNotionPageRefInTurn(text, transcript = []) {
  const fromText = findNotionPageRef(text);
  if (fromText) return fromText;
  if (!Array.isArray(transcript)) return null;
  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const line = transcript[i];
    if (line?.role !== 'user') continue;
    const found = findNotionPageRef(line.text);
    if (found) return found;
  }
  return null;
}

/**
 * 0-based portion index for this page.
 * - «часть 2» → 1
 * - first send of URL → 0
 * - «дальше» after URL → previous continues + 1
 */
export function resolveNotionPortion(text, transcript, pageId) {
  const explicit = PORTION_RE.exec(String(text || ''));
  if (explicit) return Math.max(0, Number(explicit[1]) - 1);

  const currentIsContinue = CONTINUE_RE.test(String(text || '')) && !findNotionPageRef(text);
  let portion = 0;
  let tracking = false;

  for (const line of transcript || []) {
    if (line?.role !== 'user') continue;
    const t = String(line.text || '');
    const ref = findNotionPageRef(t);
    if (ref?.pageId === pageId) {
      tracking = true;
      portion = 0;
      const n = PORTION_RE.exec(t);
      if (n) portion = Math.max(0, Number(n[1]) - 1);
      continue;
    }
    if (!tracking) continue;
    if (PORTION_RE.test(t)) {
      portion = Math.max(0, Number(PORTION_RE.exec(t)[1]) - 1);
    } else if (CONTINUE_RE.test(t)) {
      portion += 1;
    }
  }

  if (currentIsContinue) portion += 1;
  return portion;
}

/** Split full markdown into portions, preferring breaks at headings / blank lines. */
export function sliceNotionPortion(fullText, portionIndex, maxChars = NOTION_TEACH_TEXT_MAX) {
  const raw = String(fullText || '');
  if (!raw) {
    return {
      text: '',
      portion: 0,
      totalPortions: 1,
      truncated: false,
      charStart: 0,
      charEnd: 0,
      totalChars: 0,
    };
  }
  if (raw.length <= maxChars) {
    return {
      text: raw,
      portion: 0,
      totalPortions: 1,
      truncated: false,
      charStart: 0,
      charEnd: raw.length,
      totalChars: raw.length,
    };
  }

  const starts = [0];
  let pos = 0;
  while (pos < raw.length) {
    let end = Math.min(pos + maxChars, raw.length);
    if (end < raw.length) {
      const window = raw.slice(pos, end);
      const heading = Math.max(window.lastIndexOf('\n# '), window.lastIndexOf('\n## '));
      const blank = window.lastIndexOf('\n\n');
      const cut = heading >= maxChars * 0.4 ? heading : (blank >= maxChars * 0.4 ? blank : -1);
      if (cut > 0) end = pos + cut;
    }
    pos = end;
    if (pos < raw.length) starts.push(pos);
  }

  const totalPortions = starts.length;
  const portion = Math.min(Math.max(0, portionIndex), totalPortions - 1);
  const charStart = starts[portion];
  const charEnd = portion + 1 < starts.length ? starts[portion + 1] : raw.length;
  let text = raw.slice(charStart, charEnd).trim();
  if (portion > 0) text = `[…продолжение с символа ${charStart + 1}…]\n\n${text}`;
  if (portion < totalPortions - 1) {
    text = `${text}\n\n[…далее часть ${portion + 2} из ${totalPortions} — скажите «дальше»…]`;
  }

  return {
    text,
    portion,
    totalPortions,
    truncated: totalPortions > 1,
    charStart,
    charEnd,
    totalChars: raw.length,
  };
}

/**
 * @returns {null | {
 *   ref: { pageId: string, sourceUrl: string },
 *   ok: boolean,
 *   title?: string,
 *   text?: string,
 *   truncated?: boolean,
 *   complete?: boolean,
 *   portion?: number,
 *   totalPortions?: number,
 *   totalChars?: number,
 *   errors?: unknown[],
 *   error?: { code: string, message: string },
 * }}
 */
export async function loadNotionTeachingMaterial(env, text, { allow = false, transcript = [] } = {}) {
  const ref = findNotionPageRefInTurn(text, transcript);
  if (!ref) return null;
  if (!allow) {
    return {
      ref,
      ok: false,
      error: {
        code: 'admin_only',
        message: 'Чтение Notion в чате доступно только Создателю: войдите в учётную запись администратора (passkey), на странице «Вход» должно быть видно «Вы вошли как администратор».',
      },
    };
  }
  try {
    const page = await readNotionPage(env, { pageId: ref.pageId, sourceUrl: ref.sourceUrl });
    const portionIndex = resolveNotionPortion(text, transcript, ref.pageId);
    const sliced = sliceNotionPortion(page.text || '', portionIndex);
    return {
      ref,
      ok: true,
      title: page.title || '',
      text: sliced.text,
      truncated: sliced.truncated,
      complete: page.complete && !sliced.truncated,
      portion: sliced.portion,
      totalPortions: sliced.totalPortions,
      totalChars: sliced.totalChars,
      errors: page.errors,
    };
  } catch (err) {
    if (err instanceof HttpError) {
      return { ref, ok: false, error: { code: err.code, message: err.message } };
    }
    return {
      ref,
      ok: false,
      error: { code: 'notion_error', message: err?.message || 'Не удалось прочитать Notion.' },
    };
  }
}

export function formatNotionTeachingBlock(material) {
  if (!material) return '';
  const { ref } = material;
  if (!material.ok) {
    return [
      'А прислал ссылку на страницу Notion, но сервер Buddy не смог её прочитать.',
      `Ссылка: ${ref.sourceUrl}`,
      `Ошибка (${material.error?.code || 'notion_error'}): ${material.error?.message || 'неизвестно'}`,
      'Сообщите об этом честно. Не притворяйтесь, что прочитали страницу, и не просите «вставить текст» как будто ссылка недоступна в принципе — проблема техническая и её нужно устранить у Создателя (NOTION_TOKEN, Connections, deploy).',
    ].join('\n');
  }
  const title = material.title || '(без заголовка)';
  const portionLine = material.totalPortions > 1
    ? `Порция ${material.portion + 1} из ${material.totalPortions} (всего ~${material.totalChars} символов). Если А скажет «дальше» или «часть ${material.portion + 2}» — в следующем ходе придёт продолжение. Не утверждайте, что прочитали весь документ, пока не пройдены все порции.`
    : '';
  return [
    'Учебный материал из Notion уже прочитан сервером Buddy (это не выдумка модели).',
    `Источник: ${ref.sourceUrl}`,
    `pageId: ${ref.pageId}`,
    `Заголовок: ${title}`,
    portionLine,
    material.complete === false && !material.truncated ? 'Внимание: страница прочитана не полностью (см. errors).' : '',
    '--- начало материала ---',
    material.text || '(пусто)',
    '--- конец материала ---',
    'Обсуждайте и учитесь по материалу выше. НЕ просите вставить текст вручную — он уже получен.',
  ].filter(Boolean).join('\n');
}
