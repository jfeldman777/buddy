// Buddy-018 step 8A / 8A-files: Creator↔Bi teaching session — corpus then turns.
import { HttpError } from '../http.js';
import { chatJson } from '../bi/openai.js';
import { readNotionPage } from '../notion/readPage.js';
import { TUAI_INTRO_PAGES, TUAI_INTRO_CORPUS_ID, TUAI_INTRO_CORPUS_TITLE } from '../notion/tuaiIntroCatalog.js';
import { buildTeachSessionPrompt, TEACH_SESSION_STRATEGY } from './sessionPrompts.js';
import {
  getCorpusDocumentsByIds,
  listCorpusDocuments,
  documentsToPages,
} from './corpusDocuments.js';

const TEXT_MAX = 8_000;
const MESSAGES_KEEP = 80;

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function mapSession(row) {
  return {
    id: row.id,
    adminId: row.admin_id,
    status: row.status,
    corpusKind: row.corpus_kind || 'notion',
    corpusId: row.corpus_id || '',
    corpusTitle: row.corpus_kind === 'files' ? 'Файловый корпус (PDF/DOCX)' : TUAI_INTRO_CORPUS_TITLE,
    pageIds: parseJson(row.page_ids_json, []),
    ingestIndex: Number(row.ingest_index) || 0,
    pages: parseJson(row.pages_json, []),
    messages: parseJson(row.messages_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    strategyVersion: TEACH_SESSION_STRATEGY,
  };
}

function withProgress(session) {
  const total = (session.pageIds || []).length;
  const loaded = session.corpusKind === 'files'
    ? total
    : (session.pages || []).length;
  return {
    ...session,
    progress: {
      total,
      loaded,
      done: session.status === 'ready' || session.status === 'closed' || (total > 0 && loaded >= total),
      nextPageId: session.corpusKind === 'notion' && session.status === 'ingesting' && session.ingestIndex < total
        ? session.pageIds[session.ingestIndex]
        : null,
    },
  };
}

async function loadSession(env, sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) throw new HttpError(400, 'teach_session_id', 'Нужен id сессии.');
  const row = await env.DB.prepare('SELECT * FROM teach_sessions WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'teach_session_not_found', 'Учебная сессия не найдена.');
  return withProgress(mapSession(row));
}

async function saveSession(env, session) {
  await env.DB.prepare(
    `UPDATE teach_sessions
     SET status = ?1, ingest_index = ?2, pages_json = ?3, messages_json = ?4, updated_at = ?5, corpus_kind = ?6
     WHERE id = ?7`,
  ).bind(
    session.status,
    session.ingestIndex,
    JSON.stringify(session.pages || []),
    JSON.stringify(session.messages || []),
    session.updatedAt,
    session.corpusKind || 'notion',
    session.id,
  ).run();
  return withProgress(session);
}

function resolvePageIds(pageIds) {
  if (Array.isArray(pageIds) && pageIds.length) {
    const byId = new Map(TUAI_INTRO_PAGES.map((p) => [p.pageId, p]));
    const out = [];
    for (const raw of pageIds) {
      const id = String(raw || '').trim();
      const entry = byId.get(id);
      if (!entry) {
        throw new HttpError(400, 'teach_session_page', `Страница не из каталога ТУАИ: ${id}`);
      }
      out.push(entry.pageId);
    }
    return out;
  }
  return TUAI_INTRO_PAGES.map((p) => p.pageId);
}

async function resolveFileDocumentIds(env, adminId, documentIds) {
  if (Array.isArray(documentIds) && documentIds.length) {
    const docs = await getCorpusDocumentsByIds(env, { adminId, ids: documentIds, withText: false });
    return docs.map((d) => d.id);
  }
  const all = await listCorpusDocuments(env, { adminId, withText: false });
  if (!all.length) {
    throw new HttpError(400, 'teach_corpus_empty_set', 'Сначала загрузите PDF/DOCX в файловый корпус.');
  }
  return all.map((d) => d.id);
}

async function pagesForPrompt(env, session) {
  if (session.corpusKind === 'files') {
    const docs = await getCorpusDocumentsByIds(env, {
      adminId: session.adminId,
      ids: session.pageIds,
      withText: true,
    });
    return documentsToPages(docs);
  }
  return session.pages || [];
}

/**
 * @param {{ adminId: string, source?: 'notion'|'files', pageIds?: string[], documentIds?: string[] }} opts
 */
export async function startTeachSession(env, { adminId, source = 'notion', pageIds, documentIds } = {}) {
  const admin = String(adminId || '');
  if (!admin) throw new HttpError(401, 'unauthorized', 'Нужен администратор.');
  const kind = source === 'files' ? 'files' : 'notion';

  if (kind === 'files') {
    const ids = await resolveFileDocumentIds(env, admin, documentIds);
    const docs = await getCorpusDocumentsByIds(env, { adminId: admin, ids, withText: false });
    const metaPages = documentsToPages(docs.map((d) => ({ ...d, text: '' }))).map((p, i) => ({
      ...p,
      charCount: docs[i].charCount,
      status: docs[i].charCount > 0 ? 'ok' : 'incomplete',
    }));
    const session = {
      id: crypto.randomUUID(),
      adminId: admin,
      status: 'ready',
      corpusKind: 'files',
      corpusId: 'files-upload',
      corpusTitle: 'Файловый корпус (PDF/DOCX)',
      pageIds: ids,
      ingestIndex: ids.length,
      pages: metaPages,
      messages: [],
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await env.DB.prepare(
      `INSERT INTO teach_sessions
        (id, admin_id, status, corpus_id, page_ids_json, ingest_index, pages_json, messages_json, created_at, updated_at, corpus_kind)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10)`,
    ).bind(
      session.id,
      session.adminId,
      session.status,
      session.corpusId,
      JSON.stringify(session.pageIds),
      session.ingestIndex,
      JSON.stringify(session.pages),
      '[]',
      session.createdAt,
      session.corpusKind,
    ).run();
    return withProgress(session);
  }

  const ids = resolvePageIds(pageIds);
  const session = {
    id: crypto.randomUUID(),
    adminId: admin,
    status: 'ingesting',
    corpusKind: 'notion',
    corpusId: TUAI_INTRO_CORPUS_ID,
    corpusTitle: TUAI_INTRO_CORPUS_TITLE,
    pageIds: ids,
    ingestIndex: 0,
    pages: [],
    messages: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await env.DB.prepare(
    `INSERT INTO teach_sessions
      (id, admin_id, status, corpus_id, page_ids_json, ingest_index, pages_json, messages_json, created_at, updated_at, corpus_kind)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9,?10)`,
  ).bind(
    session.id,
    session.adminId,
    session.status,
    session.corpusId,
    JSON.stringify(session.pageIds),
    0,
    '[]',
    '[]',
    session.createdAt,
    session.corpusKind,
  ).run();
  return withProgress(session);
}

export async function getTeachSession(env, sessionId) {
  return loadSession(env, sessionId);
}

export async function listTeachSessions(env, { adminId, limit = 10 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 10, 1), 30);
  const { results } = await env.DB.prepare(
    `SELECT * FROM teach_sessions WHERE admin_id = ?1 ORDER BY updated_at DESC LIMIT ?2`,
  ).bind(String(adminId || ''), capped).all();
  return (results || []).map((r) => withProgress(mapSession(r)));
}

/** Load exactly one next Notion catalog page (Worker-safe). Not used for file corpus. */
export async function ingestTeachSessionPage(env, sessionId) {
  const session = await loadSession(env, sessionId);
  if (session.corpusKind === 'files') {
    return { session: withProgress(session), page: null, done: true };
  }
  if (session.status === 'closed') {
    throw new HttpError(409, 'teach_session_closed', 'Сессия закрыта.');
  }
  if (session.status === 'ready' || session.ingestIndex >= session.pageIds.length) {
    session.status = 'ready';
    session.updatedAt = nowIso();
    await saveSession(env, session);
    return { session: withProgress(session), page: null, done: true };
  }

  const pageId = session.pageIds[session.ingestIndex];
  const meta = TUAI_INTRO_PAGES.find((p) => p.pageId === pageId);
  let pageRec;
  try {
    const page = await readNotionPage(env, {
      pageId,
      sourceUrl: meta?.sourceUrl,
      expandLinkedPages: false,
    });
    pageRec = {
      n: meta?.n ?? session.ingestIndex + 1,
      pageId,
      sourceUrl: meta?.sourceUrl || page.sourceUrl || '',
      title: page.title || '',
      text: page.text || '',
      charCount: (page.text || '').length,
      status: page.complete && (page.text || '').trim() ? 'ok' : 'incomplete',
      complete: Boolean(page.complete),
    };
  } catch (err) {
    pageRec = {
      n: meta?.n ?? session.ingestIndex + 1,
      pageId,
      sourceUrl: meta?.sourceUrl || '',
      title: '',
      text: '',
      charCount: 0,
      status: 'error',
      complete: false,
      error: { code: err?.code || 'notion_error', message: err?.message || 'Не удалось прочитать страницу.' },
    };
  }

  session.pages.push(pageRec);
  session.ingestIndex += 1;
  if (session.ingestIndex >= session.pageIds.length) session.status = 'ready';
  else session.status = 'ingesting';
  session.updatedAt = nowIso();
  await saveSession(env, session);
  return {
    session: withProgress(session),
    page: {
      n: pageRec.n,
      pageId: pageRec.pageId,
      title: pageRec.title,
      status: pageRec.status,
      charCount: pageRec.charCount,
    },
    done: session.status === 'ready',
  };
}

export async function teachSessionTurn(env, sessionId, { adminId, text } = {}) {
  const session = await loadSession(env, sessionId);
  if (session.adminId && adminId && session.adminId !== adminId) {
    throw new HttpError(403, 'forbidden', 'Чужая учебная сессия.');
  }
  if (session.status === 'closed') {
    throw new HttpError(409, 'teach_session_closed', 'Сессия закрыта.');
  }
  if (session.status !== 'ready') {
    throw new HttpError(
      409,
      'teach_session_not_ready',
      `Сначала догрузите корпус (сейчас ${session.progress.loaded}/${session.progress.total}).`,
    );
  }

  const creatorText = String(text || '').trim();
  if (!creatorText) throw new HttpError(400, 'empty_turn', 'Нужен текст Создателя.');
  if (creatorText.length > TEXT_MAX) throw new HttpError(400, 'too_long', 'Слишком длинное сообщение.');

  session.messages.push({ role: 'creator', text: creatorText, at: nowIso() });

  const pages = await pagesForPrompt(env, session);
  const prompt = buildTeachSessionPrompt({
    corpusTitle: session.corpusTitle,
    pages,
    messages: session.messages,
  });

  const { json: reply, usage } = await chatJson(env, {
    sessionId: `teach-session:${session.id}`,
    speaker: 'bi',
    system: prompt.system,
    user: prompt.user,
  });

  const utterance = typeof reply.utterance === 'string' ? reply.utterance.trim() : '';
  if (!utterance || utterance.length > TEXT_MAX) {
    throw new HttpError(502, 'model_bad_json', 'Би не дал понятной реплики.');
  }
  const kind = ['answer', 'question', 'other'].includes(reply.kind) ? reply.kind : 'other';

  session.messages.push({ role: 'bi', text: utterance, kind, at: nowIso() });
  if (session.messages.length > MESSAGES_KEEP) {
    session.messages = session.messages.slice(-MESSAGES_KEEP);
  }
  session.updatedAt = nowIso();
  await saveSession(env, session);

  return {
    session: withProgress(session),
    reply: { utterance, kind },
    usage,
    isolation: {
      wroteChatMemory: false,
      wroteBiTeachings: false,
      wroteKb: false,
    },
  };
}

export async function closeTeachSession(env, sessionId) {
  const session = await loadSession(env, sessionId);
  session.status = 'closed';
  session.updatedAt = nowIso();
  await saveSession(env, session);
  return withProgress(session);
}

export const __test = { resolvePageIds, mapSession, withProgress };
