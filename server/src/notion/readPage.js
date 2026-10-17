// Read one Notion page via the official API. Token stays in Worker secrets (NOTION_TOKEN).
import { HttpError } from '../http.js';

export const NOTION_VERSION = '2022-06-28';
export const NOTION_API = 'https://api.notion.com/v1';

/** First teaching chapter (Buddy-018). */
export const FIRST_CHAPTER_PAGE_ID = '3f622db3-cb08-8059-8c37-e17046263550';
export const FIRST_CHAPTER_SOURCE_URL = 'https://app.notion.com/p/1-3f622db3cb0880598c37e17046263550';

const PAGE_SIZE = 100;
const MAX_DEPTH = 24;
const MAX_BLOCKS = 5000;
/** Extra Notion pages to expand via link_to_page (child_page uses the same block id). */
const MAX_LINKED_PAGES = 48;

const RICH_TEXT_TYPES = new Set([
  'paragraph', 'heading_1', 'heading_2', 'heading_3',
  'bulleted_list_item', 'numbered_list_item', 'quote', 'callout',
  'to_do', 'toggle', 'code',
]);

const STRUCTURAL_TYPES = new Set([
  'column_list', 'column', 'synced_block', 'table', 'table_row',
]);

const MEDIA_URL_TYPES = new Set(['bookmark', 'embed', 'link_preview', 'pdf', 'video', 'file', 'image']);

/** Normalize Notion page/block id (with or without dashes; strip public `N-` prefix). */
export function normalizePageId(raw) {
  let s = String(raw ?? '').trim();
  const prefixed = /^(\d+)-([0-9a-fA-F]{32})$/.exec(s);
  if (prefixed) s = prefixed[2];
  const hex = s.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new HttpError(400, 'bad_page_id', 'Нужен идентификатор страницы Notion (32 hex-символа).');
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const NOTION_URL_RE = /https?:\/\/(?:www\.|app\.)?notion\.(?:so|com)\/[^\s<>'")\]]+/gi;
/** Last path segment ends with optional title-, optional N-, then 32 hex. */
const PAGE_ID_IN_SEGMENT_RE = /(?:^|-)([0-9a-fA-F]{32})$/i;

/**
 * Find the first Notion page URL in free text (Buddy-018 teaching).
 * @returns {{ pageId: string, sourceUrl: string } | null}
 */
export function findNotionPageRef(text) {
  const raw = String(text ?? '');
  for (const match of raw.matchAll(NOTION_URL_RE)) {
    let href = match[0].replace(/[.,;:!?]+$/, '');
    try {
      const u = new URL(href);
      const path = decodeURIComponent(u.pathname);
      const segment = path.split('/').filter(Boolean).pop() || '';
      const idMatch = PAGE_ID_IN_SEGMENT_RE.exec(segment);
      if (!idMatch) continue;
      const pageId = normalizePageId(idMatch[1]);
      return { pageId, sourceUrl: href };
    } catch {
      /* try next match */
    }
  }
  return null;
}

export function sourceUrlForPageId(pageId) {
  const id = normalizePageId(pageId);
  if (id === FIRST_CHAPTER_PAGE_ID) return FIRST_CHAPTER_SOURCE_URL;
  return `https://www.notion.so/${id.replace(/-/g, '')}`;
}

export function richTextToMarkdown(richText) {
  if (!Array.isArray(richText) || !richText.length) return '';
  return richText.map((part) => {
    const text = String(part?.plain_text ?? '');
    const href = part?.href || part?.text?.link?.url || null;
    if (href && text) return `[${text}](${href})`;
    return text;
  }).join('');
}

export function extractTitle(page) {
  if (!page || typeof page !== 'object') return '';
  const props = page.properties;
  if (props && typeof props === 'object') {
    for (const value of Object.values(props)) {
      if (value?.type === 'title' && Array.isArray(value.title)) {
        return richTextToMarkdown(value.title).trim();
      }
    }
  }
  return '';
}

function indent(depth) {
  return '  '.repeat(Math.max(0, depth));
}

/**
 * Convert already-loaded Notion blocks (with optional `.children` arrays) to Markdown.
 * Unknown types are listed in `unknownBlockTypes`; conversion continues.
 */
export function blocksToMarkdown(blocks, {
  depth = 0,
  unknownBlockTypes = new Set(),
  listCounters = [],
  trimResult = true,
} = {}) {
  const lines = [];
  const counters = listCounters.slice();

  for (const block of blocks ?? []) {
    const type = block?.type ?? 'unknown';
    const payload = block?.[type] ?? {};
    const pad = indent(depth);
    let line = null;

    if (type === 'paragraph') {
      const text = richTextToMarkdown(payload.rich_text);
      if (text) line = `${pad}${text}`;
      else line = '';
    } else if (type === 'heading_1') {
      line = `${pad}# ${richTextToMarkdown(payload.rich_text)}`;
    } else if (type === 'heading_2') {
      line = `${pad}## ${richTextToMarkdown(payload.rich_text)}`;
    } else if (type === 'heading_3') {
      line = `${pad}### ${richTextToMarkdown(payload.rich_text)}`;
    } else if (type === 'quote') {
      const text = richTextToMarkdown(payload.rich_text);
      line = text ? `${pad}> ${text}` : `${pad}>`;
    } else if (type === 'bulleted_list_item') {
      line = `${pad}- ${richTextToMarkdown(payload.rich_text)}`;
    } else if (type === 'numbered_list_item') {
      while (counters.length <= depth) counters.push(0);
      counters[depth] = (counters[depth] || 0) + 1;
      for (let i = depth + 1; i < counters.length; i++) counters[i] = 0;
      line = `${pad}${counters[depth]}. ${richTextToMarkdown(payload.rich_text)}`;
    } else if (type === 'to_do') {
      const mark = payload.checked ? 'x' : ' ';
      line = `${pad}- [${mark}] ${richTextToMarkdown(payload.rich_text)}`;
    } else if (type === 'toggle' || type === 'callout') {
      line = `${pad}${richTextToMarkdown(payload.rich_text)}`;
    } else if (type === 'code') {
      const lang = payload.language && payload.language !== 'plain text' ? payload.language : '';
      const body = richTextToMarkdown(payload.rich_text);
      lines.push(`${pad}\`\`\`${lang}`, body, `${pad}\`\`\``);
    } else if (type === 'divider') {
      line = `${pad}---`;
    } else if (type === 'child_page') {
      const childTitle = payload.title || block.id;
      line = `${pad}# ${childTitle}`;
    } else if (type === 'child_database') {
      line = `${pad}[child database: ${payload.title ?? block.id}]`;
    } else if (type === 'link_to_page') {
      const target = payload.page_id || payload.database_id || '';
      const expanded = block._expanded_title;
      if (expanded) line = `${pad}# ${expanded}`;
      else {
        line = target
          ? `${pad}[link to page](https://www.notion.so/${String(target).replace(/-/g, '')})`
          : `${pad}[link to page]`;
      }
    } else if (MEDIA_URL_TYPES.has(type)) {
      const url = payload.url
        || payload.external?.url
        || payload.file?.url
        || '';
      const caption = richTextToMarkdown(payload.caption);
      if (url && caption) line = `${pad}[${caption}](${url})`;
      else if (url) line = `${pad}${url}`;
      else if (caption) line = `${pad}${caption}`;
      else {
        unknownBlockTypes.add(type);
        line = `${pad}[${type}]`;
      }
    } else if (type === 'table_row') {
      const cells = (payload.cells ?? []).map((cell) => richTextToMarkdown(cell));
      line = `${pad}| ${cells.join(' | ')} |`;
    } else if (STRUCTURAL_TYPES.has(type) || type === 'table_of_contents' || type === 'breadcrumb') {
      // Structure only — children (if any) carry the text.
      line = null;
    } else if (RICH_TEXT_TYPES.has(type)) {
      line = `${pad}${richTextToMarkdown(payload.rich_text)}`;
    } else {
      unknownBlockTypes.add(type);
      const fallback = Array.isArray(payload.rich_text) ? richTextToMarkdown(payload.rich_text) : '';
      line = fallback ? `${pad}${fallback}` : `${pad}[unsupported block: ${type}]`;
    }

    if (line !== null) lines.push(line);

    if (Array.isArray(block.children) && block.children.length) {
      const childDepth = (type === 'bulleted_list_item' || type === 'numbered_list_item' || type === 'to_do' || type === 'toggle' || type === 'quote' || type === 'callout')
        ? depth + 1
        : (type === 'column_list' || type === 'column' || type === 'synced_block' || type === 'table')
          ? depth
          : depth + 1;
      const nested = blocksToMarkdown(block.children, {
        depth: childDepth,
        unknownBlockTypes,
        listCounters: type === 'numbered_list_item' ? counters : [],
        trimResult: false,
      });
      if (nested.text) lines.push(nested.text);
    }
  }

  const joined = lines.join('\n').replace(/\n{3,}/g, '\n\n');
  return {
    // Do not trim nested calls — leading spaces are list indentation.
    text: trimResult ? joined.trim() : joined,
    unknownBlockTypes: [...unknownBlockTypes].sort(),
  };
}

async function notionGet(env, path) {
  const fetchImpl = env.FETCH ?? fetch;
  const response = await fetchImpl(`${NOTION_API}${path}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.NOTION_TOKEN}`,
      'Notion-Version': NOTION_VERSION,
    },
  });
  return response;
}

function notionErrorMessage(status, bodyText) {
  let apiMessage = '';
  try {
    apiMessage = String(JSON.parse(bodyText)?.message ?? '');
  } catch {
    /* ignore */
  }
  if (status === 401) {
    return { code: 'notion_unauthorized', message: 'Notion отклонил токен. Проверьте NOTION_TOKEN и доступ integration к странице.' };
  }
  if (status === 403) {
    return { code: 'notion_forbidden', message: 'Нет доступа к странице Notion. Подключите integration к странице (Connections).' };
  }
  if (status === 404) {
    return {
      code: 'notion_not_found',
      message: apiMessage || 'Страница Notion не найдена или integration к ней не подключена.',
    };
  }
  if (status === 429) {
    return { code: 'notion_rate_limit', message: 'Notion ограничил частоту запросов. Попробуйте через минуту.' };
  }
  return { code: 'notion_error', message: apiMessage || 'Ошибка чтения Notion API.' };
}

async function fetchAllChildren(env, blockId, state) {
  const results = [];
  let cursor;
  do {
    if (state.blockCount >= MAX_BLOCKS) {
      state.errors.push({ where: `blocks/${blockId}/children`, message: `Превышен лимит блоков (${MAX_BLOCKS}).` });
      state.complete = false;
      return results;
    }
    const query = new URLSearchParams({ page_size: String(PAGE_SIZE) });
    if (cursor) query.set('start_cursor', cursor);
    let response;
    try {
      response = await notionGet(env, `/blocks/${blockId}/children?${query}`);
    } catch (err) {
      state.errors.push({ where: `blocks/${blockId}/children`, message: err?.message || 'Сеть недоступна.' });
      state.complete = false;
      return results;
    }
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      const { message } = notionErrorMessage(response.status, errText);
      state.errors.push({ where: `blocks/${blockId}/children`, status: response.status, message });
      state.complete = false;
      return results;
    }
    let data;
    try {
      data = await response.json();
    } catch {
      state.errors.push({ where: `blocks/${blockId}/children`, message: 'Ответ Notion не JSON.' });
      state.complete = false;
      return results;
    }
    const batch = Array.isArray(data.results) ? data.results : [];
    state.blockCount += batch.length;
    results.push(...batch);
    cursor = data.has_more ? data.next_cursor : null;
    if (data.has_more && !data.next_cursor) {
      state.errors.push({ where: `blocks/${blockId}/children`, message: 'Пагинация оборвалась: has_more без next_cursor.' });
      state.complete = false;
      break;
    }
  } while (cursor);
  return results;
}

async function loadTree(env, blockId, state, depth) {
  if (depth > MAX_DEPTH) {
    state.errors.push({ where: `blocks/${blockId}`, message: `Превышена глубина вложенности (${MAX_DEPTH}).` });
    state.complete = false;
    return [];
  }
  const children = await fetchAllChildren(env, blockId, state);
  for (const block of children) {
    if (block.type === 'link_to_page' && block.link_to_page?.type === 'page_id' && block.link_to_page.page_id) {
      if (!state.expandLinkedPages) continue;
      let pid;
      try {
        pid = normalizePageId(block.link_to_page.page_id);
      } catch {
        continue;
      }
      if (state.visitedPages.has(pid)) continue;
      if (state.linkedPages >= MAX_LINKED_PAGES) {
        state.errors.push({
          where: `link_to_page/${pid}`,
          message: `Достигнут лимит связанных страниц (${MAX_LINKED_PAGES}).`,
        });
        state.complete = false;
        continue;
      }
      state.visitedPages.add(pid);
      state.linkedPages += 1;
      try {
        const pageRes = await notionGet(env, `/pages/${pid}`);
        if (pageRes.ok) {
          const pageJson = await pageRes.json();
          block._expanded_title = extractTitle(pageJson) || pid;
        } else {
          block._expanded_title = pid;
        }
      } catch {
        block._expanded_title = pid;
      }
      block.children = await loadTree(env, pid, state, depth + 1);
      continue;
    }
    if (block.has_children) {
      // child_page / child_database are other Notion pages — optional expand.
      if (block.type === 'child_page' || block.type === 'child_database') {
        if (!state.expandLinkedPages) continue;
        state.visitedPages.add(block.id);
      }
      block.children = await loadTree(env, block.id, state, depth + 1);
    }
  }
  return children;
}

/**
 * Read a Notion page: title + Markdown body.
 * Does not throw on partial content — returns complete=false and errors[].
 * Throws HttpError only for misconfiguration / invalid id / hard auth failures on the page itself.
 *
 * @param {boolean} [options.expandLinkedPages=true] When false, do not pull bodies of child_page /
 *   link_to_page (corpus mode: one catalog page at a time). Toggles/lists on the page still expand.
 */
export async function readNotionPage(env, {
  pageId = FIRST_CHAPTER_PAGE_ID,
  sourceUrl,
  expandLinkedPages = true,
} = {}) {
  if (!env.NOTION_TOKEN) {
    throw new HttpError(503, 'unconfigured', 'Сервер не настроен: нет NOTION_TOKEN.');
  }
  const id = normalizePageId(pageId);
  const url = sourceUrl || sourceUrlForPageId(id);
  const state = {
    complete: true,
    errors: [],
    blockCount: 0,
    unknownBlockTypes: new Set(),
    expandLinkedPages: expandLinkedPages !== false,
  };

  let page;
  let response;
  try {
    response = await notionGet(env, `/pages/${id}`);
  } catch (err) {
    throw new HttpError(503, 'notion_unavailable', 'Notion сейчас недоступен. Попробуйте позже.');
  }
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    const { code, message } = notionErrorMessage(response.status, errText);
    throw new HttpError(response.status === 404 ? 404 : 502, code, message);
  }
  try {
    page = await response.json();
  } catch {
    throw new HttpError(502, 'notion_error', 'Ответ Notion (страница) не JSON.');
  }

  const title = extractTitle(page);
  state.visitedPages = new Set([id]);
  state.linkedPages = 0;
  const blocks = await loadTree(env, id, state, 0);
  const rendered = blocksToMarkdown(blocks, { unknownBlockTypes: state.unknownBlockTypes });

  return {
    sourceUrl: url,
    pageId: id,
    title,
    text: rendered.text,
    complete: state.complete && state.errors.length === 0,
    unknownBlockTypes: rendered.unknownBlockTypes,
    errors: state.errors,
  };
}
