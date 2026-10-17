import { HttpError, json, readJson, now } from '../http.js';
import { authenticate } from '../sessions.js';
import { rateLimit } from '../limits.js';
import { chatBudgetView } from './chatBudget.js';
import { MEMORY_CONSENT_TEXT, MEMORY_CONSENT_VERSION } from './consent.js';
import { buildABiPrompt, ABI_STRATEGY_VERSION } from './prompts.js';
import { chatJson } from './openai.js';
import { formatNotionTeachingBlock, loadNotionTeachingMaterial } from './notionTeach.js';

const TEXT_MAX = 4_000;
const TURN_BODY_MAX = 400 * 1024;
const PHOTO_DATA_MAX = 350_000;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/;
const MAPS = new Set(['personality', 'worldview', 'communication']);
const LAYERS = new Set(['fact', 'valuation', 'plan']);
const TRANSCRIPT_MAX = 60;
const TRANSCRIPT_LINE_MAX = 2_000;
const ROLES = new Set(['user', 'bi']);

function parseTranscript(raw) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, 'bad_transcript', 'Переписка должна быть списком реплик.');
  const out = [];
  for (const item of raw.slice(-TRANSCRIPT_MAX)) {
    const role = item?.role === 'a' ? 'user' : item?.role;
    if (!ROLES.has(role)) continue;
    const text = typeof item?.text === 'string' ? item.text.trim().slice(0, TRANSCRIPT_LINE_MAX) : '';
    if (!text || text.startsWith('(Контекст с сервера)')) continue;
    out.push({ role, text });
  }
  return out;
}

const iso = (env) => new Date(now(env)).toISOString();

async function requireUser(request, env) {
  const session = await authenticate(request, env);
  await rateLimit(env, 'LIMIT_USER', `bi:${session.userId}`);
  return session;
}

async function requireConsent(env, userId) {
  const row = await env.DB.prepare(
    'SELECT consent_version FROM bi_memory_consent WHERE user_id = ?1',
  ).bind(userId).first();
  if (!row || row.consent_version !== MEMORY_CONSENT_VERSION) {
    throw new HttpError(403, 'consent_required', 'Сначала нужно согласие на серверную память Би.');
  }
}

function parsePhotoData(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new HttpError(400, 'bad_photo', 'Фото должно быть строкой data URL.');
  const photo = value.replace(/\s+/g, '');
  if (photo.length > PHOTO_DATA_MAX) throw new HttpError(413, 'photo_too_large', 'Фото слишком большое.');
  if (!PHOTO_RE.test(photo)) throw new HttpError(400, 'bad_photo', 'Нужно фото JPEG, PNG или WebP.');
  return photo;
}

async function knowledgeEpoch(env) {
  const row = await env.DB.prepare(
    `SELECT MAX(u) AS epoch FROM (
       SELECT updated_at AS u FROM kb_shared WHERE status = 'approved'
       UNION ALL
       SELECT updated_at AS u FROM bi_strategies WHERE status = 'approved'
     )`,
  ).first();
  return row?.epoch ?? '';
}

async function loadMemoryBundle(env, userId) {
  const { results: entries } = await env.DB.prepare(
    `SELECT id, map, layer, provenance, text FROM bi_memory_entries
     WHERE user_id = ?1 AND deleted = 0 AND forbidden = 0
     ORDER BY updated_at DESC LIMIT 80`,
  ).bind(userId).all();
  const { results: teachings } = await env.DB.prepare(
    `SELECT id, formulation FROM bi_teachings WHERE user_id = ?1 AND status = 'confirmed'
     ORDER BY updated_at DESC LIMIT 40`,
  ).bind(userId).all();
  const { results: sharedKnowledge } = await env.DB.prepare(
    `SELECT id, formulation, version FROM kb_shared WHERE status = 'approved' ORDER BY updated_at DESC LIMIT 40`,
  ).bind().all();
  const { results: strategies } = await env.DB.prepare(
    `SELECT id, title, body FROM bi_strategies WHERE status = 'approved' ORDER BY updated_at DESC LIMIT 20`,
  ).bind().all();
  const ctxRow = await env.DB.prepare(
    `SELECT session_id AS sessionId, summary, open_threads_json AS openThreadsJson,
            active_teaching_id AS activeTeachingId, last_utterance AS lastUtterance, updated_at AS updatedAt
     FROM bi_conversation_context WHERE user_id = ?1`,
  ).bind(userId).first();
  let openThreads = [];
  try {
    openThreads = JSON.parse(ctxRow?.openThreadsJson ?? '[]');
    if (!Array.isArray(openThreads)) openThreads = [];
  } catch {
    openThreads = [];
  }
  return {
    entries,
    teachings,
    sharedKnowledge,
    strategies,
    context: ctxRow
      ? {
        sessionId: ctxRow.sessionId,
        summary: ctxRow.summary,
        openThreads,
        activeTeachingId: ctxRow.activeTeachingId,
        lastUtterance: ctxRow.lastUtterance || '',
        updatedAt: ctxRow.updatedAt,
      }
      : null,
    knowledgeEpoch: await knowledgeEpoch(env),
  };
}

async function ensureOpenSession(env, userId) {
  const open = await env.DB.prepare(
    `SELECT id FROM bi_chat_sessions WHERE user_id = ?1 AND status = 'open' ORDER BY started_at DESC LIMIT 1`,
  ).bind(userId).first();
  if (open) return open.id;
  const id = crypto.randomUUID();
  const at = iso(env);
  const epoch = await knowledgeEpoch(env);
  await env.DB.prepare(
    `INSERT INTO bi_chat_sessions (id, user_id, status, strategy_version, model, knowledge_epoch, started_at)
     VALUES (?1, ?2, 'open', ?3, ?4, ?5, ?6)`,
  ).bind(id, userId, ABI_STRATEGY_VERSION, String(env.OPENAI_MODEL ?? ''), epoch, at).run();
  return id;
}

async function saveContext(env, userId, sessionId, { summary, openThreads, activeTeachingId, lastUtterance }) {
  const at = iso(env);
  const threads = JSON.stringify(Array.isArray(openThreads) ? openThreads.slice(0, 20).map(String) : []);
  const last = String(lastUtterance ?? '').slice(0, TEXT_MAX);
  await env.DB.prepare(
    `INSERT INTO bi_conversation_context
       (user_id, session_id, summary, open_threads_json, active_teaching_id, last_utterance, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT(user_id) DO UPDATE SET
       session_id = excluded.session_id,
       summary = excluded.summary,
       open_threads_json = excluded.open_threads_json,
       active_teaching_id = excluded.active_teaching_id,
       last_utterance = excluded.last_utterance,
       updated_at = excluded.updated_at`,
  ).bind(userId, sessionId, String(summary ?? '').slice(0, TEXT_MAX), threads, activeTeachingId ?? null, last, at).run();
}

async function saveMemoryCandidates(env, userId, candidates) {
  if (!Array.isArray(candidates) || !candidates.length) return [];
  const at = iso(env);
  const saved = [];
  for (const raw of candidates.slice(0, 5)) {
    const map = MAPS.has(raw?.map) ? raw.map : null;
    const layer = LAYERS.has(raw?.layer) ? raw.layer : null;
    const text = typeof raw?.text === 'string' ? raw.text.trim().slice(0, 500) : '';
    if (!map || !layer || !text) continue;
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO bi_memory_entries (id, user_id, map, layer, provenance, text, source, confidence, forbidden, deleted, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, 'hypothesis', ?5, 'bi_turn', 0.4, 0, 0, ?6, ?6)`,
    ).bind(id, userId, map, layer, text, at).run();
    await env.DB.prepare(
      `INSERT INTO bi_memory_revisions (id, entry_id, user_id, action, prev_text, new_text, created_at)
       VALUES (?1, ?2, ?3, 'create', NULL, ?4, ?5)`,
    ).bind(crypto.randomUUID(), id, userId, text, at).run();
    saved.push({ id, map, layer, text, provenance: 'hypothesis' });
  }
  return saved;
}

async function getConsent(request, env) {
  const session = await requireUser(request, env);
  const row = await env.DB.prepare(
    'SELECT consent_version AS version, consented_at AS at FROM bi_memory_consent WHERE user_id = ?1',
  ).bind(session.userId).first();
  return json({
    consent: {
      required: true,
      version: MEMORY_CONSENT_VERSION,
      text: MEMORY_CONSENT_TEXT,
      given: Boolean(row && row.version === MEMORY_CONSENT_VERSION),
      givenVersion: row?.version ?? null,
      givenAt: row?.at ?? null,
    },
  });
}

async function postConsent(request, env) {
  const session = await requireUser(request, env);
  const body = await readJson(request);
  if (body.accept !== true) throw new HttpError(400, 'consent_required', 'Нужно явное согласие (accept: true).');
  if (body.version && body.version !== MEMORY_CONSENT_VERSION) {
    throw new HttpError(400, 'consent_version', 'Устаревшая версия текста согласия. Обновите страницу.');
  }
  const at = iso(env);
  await env.DB.prepare(
    `INSERT INTO bi_memory_consent (user_id, consent_version, consented_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET consent_version = excluded.consent_version, consented_at = excluded.consented_at`,
  ).bind(session.userId, MEMORY_CONSENT_VERSION, at).run();
  return json({
    consent: {
      required: true,
      version: MEMORY_CONSENT_VERSION,
      text: MEMORY_CONSENT_TEXT,
      given: true,
      givenVersion: MEMORY_CONSENT_VERSION,
      givenAt: at,
    },
  });
}

async function getChatBudget(request, env) {
  await requireUser(request, env);
  return json({ budget: await chatBudgetView(env) });
}

async function getContext(request, env) {
  const session = await requireUser(request, env);
  await requireConsent(env, session.userId);
  const bundle = await loadMemoryBundle(env, session.userId);
  const budget = await chatBudgetView(env);
  return json({
    context: bundle.context,
    memoryCount: bundle.entries.length,
    teachingCount: bundle.teachings.length,
    knowledgeEpoch: bundle.knowledgeEpoch,
    strategyVersion: ABI_STRATEGY_VERSION,
    budget,
  });
}

async function chatTurn(request, env) {
  const session = await requireUser(request, env);
  await requireConsent(env, session.userId);
  const body = await readJson(request, { maxBytes: TURN_BODY_MAX });
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const photoData = parsePhotoData(body.photoData);
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 40) : '';
  const opening = body.open === true;
  const transcript = parseTranscript(body.transcript);
  if (!text && !photoData && !opening) throw new HttpError(400, 'empty_turn', 'Нужен текст, фото или открытие разговора.');
  if (text.length > TEXT_MAX) throw new HttpError(400, 'too_long', 'Слишком длинное сообщение.');

  const chatSessionId = await ensureOpenSession(env, session.userId);
  const bundle = await loadMemoryBundle(env, session.userId);
  const lastBiUtterance = typeof body.lastBiReply === 'string'
    ? body.lastBiReply.trim().slice(0, TEXT_MAX)
    : '';
  const canReadNotion = session.role === 'admin' && session.elevated;
  // Buddy-018: only Creator (elevated admin) pulls Notion into the Bi prompt.
  const notionMaterial = (text && canReadNotion)
    ? await loadNotionTeachingMaterial(env, text, { allow: true })
    : null;
  const notionTeachingBlock = formatNotionTeachingBlock(notionMaterial);
  if (notionMaterial?.ok) {
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `notion_teach:${notionMaterial.ref.pageId}`, iso(env)).run();
  }
  const prompt = buildABiPrompt({
    displayName,
    memoryEntries: bundle.entries,
    teachings: bundle.teachings,
    sharedKnowledge: bundle.sharedKnowledge,
    strategies: bundle.strategies,
    context: bundle.context,
    transcript,
    lastBiUtterance,
    hasPhoto: Boolean(photoData),
    notionTeachingBlock,
  });
  const userMessage = [
    text || (opening ? '(А открыл разговор и ждёт вас.)' : '(А прислал фото без текста.)'),
    photoData ? 'К сообщению приложено фото.' : '',
  ].filter(Boolean).join('\n');

  const { json: reply, usage } = await chatJson(env, {
    sessionId: chatSessionId,
    speaker: 'bi',
    system: prompt.system,
    user: `${prompt.user}\n\nТекущая реплика А (ответ на вашу последнюю реплику выше, если она была):\n${userMessage}`,
    imageDataUrl: photoData,
  });

  const utterance = typeof reply.utterance === 'string' ? reply.utterance.trim() : '';
  if (!utterance || utterance.length > TEXT_MAX) {
    throw new HttpError(502, 'model_bad_json', 'Би не дал понятной реплики.');
  }
  const summary = typeof reply.summary === 'string' ? reply.summary.trim().slice(0, TEXT_MAX) : (bundle.context?.summary ?? '');
  const openThreads = Array.isArray(reply.open_threads) ? reply.open_threads : (bundle.context?.openThreads ?? []);
  await saveContext(env, session.userId, chatSessionId, { summary, openThreads, lastUtterance: utterance });
  const savedCandidates = await saveMemoryCandidates(env, session.userId, reply.memory_candidates);

  const budget = await chatBudgetView(env);
  const epoch = await knowledgeEpoch(env);
  const notionMeta = notionMaterial
    ? {
      pageId: notionMaterial.ref.pageId,
      sourceUrl: notionMaterial.ref.sourceUrl,
      ok: notionMaterial.ok,
      title: notionMaterial.title || null,
      truncated: Boolean(notionMaterial.truncated),
      complete: notionMaterial.complete ?? null,
      error: notionMaterial.error || null,
    }
    : null;
  return json({
    reply: utterance,
    sessionId: chatSessionId,
    context: { summary, openThreads, lastUtterance: utterance },
    memoryCandidates: savedCandidates,
    usedKnowledgeIds: Array.isArray(reply.used_knowledge_ids) ? reply.used_knowledge_ids.map(String).slice(0, 20) : [],
    knowledgeEpoch: epoch,
    strategyVersion: ABI_STRATEGY_VERSION,
    budget,
    usage,
    notion: notionMeta,
  });
}

export async function handleBi(request, env) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const key = `${method} ${path}`;

  if (key === 'GET /chat/consent') return getConsent(request, env);
  if (key === 'POST /chat/consent') return postConsent(request, env);
  if (key === 'GET /chat/budget') return getChatBudget(request, env);
  if (key === 'GET /chat/context') return getContext(request, env);
  if (key === 'POST /chat/turn') return chatTurn(request, env);

  return json({ error: 'not_found', message: 'Нет такого адреса.' }, 404);
}

export const __test = {
  MEMORY_CONSENT_VERSION,
  MEMORY_CONSENT_TEXT,
  buildABiPrompt,
  ABI_STRATEGY_VERSION,
  parseTranscript,
};
