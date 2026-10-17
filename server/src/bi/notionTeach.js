// Buddy-018 step 2: when Creator (elevated admin) pastes a Notion URL in chat,
// load the page server-side and hand Markdown to Bi. No teaching UI / durable KB yet.
import { HttpError } from '../http.js';
import { findNotionPageRef, readNotionPage } from '../notion/readPage.js';

/** Soft cap so chat turns stay within budget/context. */
export const NOTION_TEACH_TEXT_MAX = 14_000;

/**
 * @returns {null | {
 *   ref: { pageId: string, sourceUrl: string },
 *   ok: boolean,
 *   title?: string,
 *   text?: string,
 *   truncated?: boolean,
 *   complete?: boolean,
 *   errors?: unknown[],
 *   error?: { code: string, message: string },
 * }}
 */
export async function loadNotionTeachingMaterial(env, text, { allow = false } = {}) {
  const ref = findNotionPageRef(text);
  if (!ref) return null;
  if (!allow) {
    return {
      ref,
      ok: false,
      error: {
        code: 'admin_only',
        message: 'Чтение Notion в чате доступно только Создателю (вход администратора по passkey).',
      },
    };
  }
  try {
    const page = await readNotionPage(env, { pageId: ref.pageId, sourceUrl: ref.sourceUrl });
    let body = page.text || '';
    let truncated = false;
    if (body.length > NOTION_TEACH_TEXT_MAX) {
      body = `${body.slice(0, NOTION_TEACH_TEXT_MAX)}\n\n[…текст обрезан для этого хода…]`;
      truncated = true;
    }
    return {
      ref,
      ok: true,
      title: page.title || '',
      text: body,
      truncated,
      complete: page.complete && !truncated,
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
  return [
    'Учебный материал из Notion уже прочитан сервером Buddy (это не выдумка модели).',
    `Источник: ${ref.sourceUrl}`,
    `pageId: ${ref.pageId}`,
    `Заголовок: ${title}`,
    material.truncated ? 'Внимание: текст обрезан по лимиту хода.' : '',
    material.complete === false ? 'Внимание: страница прочитана не полностью (см. errors).' : '',
    '--- начало материала ---',
    material.text || '(пусто)',
    '--- конец материала ---',
    'Обсуждайте и учитесь по материалу выше. НЕ просите вставить текст вручную — он уже получен.',
  ].filter(Boolean).join('\n');
}
