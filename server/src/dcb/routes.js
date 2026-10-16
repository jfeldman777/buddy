import { HttpError, json, readJson, now } from '../http.js';
import { requireAdmin } from '../sessions.js';
import { rateLimit } from '../limits.js';
import { budgetView } from './budget.js';
import { BI_STRATEGY_VERSION, buildBiPrompt, buildSiPrompt, buildContradictionPrompt } from './prompts.js';
import { chatJson } from './openai.js';

const TITLE_MAX = 120;
const BIO_MAX = 20_000;
const TEXT_MAX = 4_000;
// Persona create/patch may include a resized portrait data URL.
const PERSONA_BODY_MAX = 400 * 1024;
const PHOTO_DATA_MAX = 350_000;
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=\s]+$/;
const MAX_SESSION_PHOTOS = 20;
const BI_PHOTOS_PER_TURN = 2;
const LABEL_MAX = 120;

const iso = (env) => new Date(now(env)).toISOString();

function parsePhotoData(value, { allowNull = false } = {}) {
  if (value === null || value === '') {
    if (!allowNull) throw new HttpError(400, 'bad_photo', 'Некорректное фото.');
    return null;
  }
  if (typeof value !== 'string') throw new HttpError(400, 'bad_photo', 'Фото должно быть строкой data URL.');
  const photo = value.replace(/\s+/g, '');
  if (photo.length > PHOTO_DATA_MAX) throw new HttpError(413, 'photo_too_large', 'Фото слишком большое. Сожмите изображение и попробуйте снова.');
  if (!PHOTO_RE.test(photo)) throw new HttpError(400, 'bad_photo', 'Нужно фото JPEG, PNG или WebP (data URL).');
  return photo;
}

async function requireDi(request, env) {
  // First Di is the administrator with an elevated passkey session.
  const session = await requireAdmin(request, env);
  await rateLimit(env, 'LIMIT_USER', `dcb:${session.userId}`);
  return session;
}

function asStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === 'string').map((item) => item.trim()).filter(Boolean).slice(0, 40);
}

function parseModel(row) {
  return {
    biography: row?.biography ?? '',
    facts: JSON.parse(row?.facts_json ?? '[]'),
    hypotheses: JSON.parse(row?.hypotheses_json ?? '[]'),
    unknowns: JSON.parse(row?.unknowns_json ?? '[]'),
  };
}

async function loadSession(env, sessionId, diUserId) {
  const session = await env.DB.prepare(
    `SELECT s.*, p.title AS persona_title, p.secret_bio, p.photo_data, p.di_user_id AS persona_di
     FROM dcb_sessions s JOIN dcb_personas p ON p.id = s.persona_id WHERE s.id = ?1`,
  ).bind(sessionId).first();
  if (!session || session.di_user_id !== diUserId) throw new HttpError(404, 'not_found', 'Сеанс не найден.');
  return session;
}

async function loadMessages(env, sessionId) {
  const { results } = await env.DB.prepare(
    'SELECT id, speaker, text, created_at AS at, seq FROM dcb_messages WHERE session_id = ?1 ORDER BY seq',
  ).bind(sessionId).all();
  return results;
}

async function loadMemory(env, sessionId) {
  const { results } = await env.DB.prepare(
    'SELECT id, fact, source, created_at AS at FROM dcb_persona_memory WHERE session_id = ?1 ORDER BY created_at',
  ).bind(sessionId).all();
  return results;
}

async function loadSessionPhotos(env, sessionId) {
  const { results } = await env.DB.prepare(
    'SELECT id, photo_data, label, created_at AS at, seq FROM dcb_session_photos WHERE session_id = ?1 ORDER BY seq',
  ).bind(sessionId).all();
  return results;
}

async function nextSeq(env, sessionId) {
  const row = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM dcb_messages WHERE session_id = ?1').bind(sessionId).first();
  return row.m + 1;
}

async function nextPhotoSeq(env, sessionId) {
  const row = await env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM dcb_session_photos WHERE session_id = ?1').bind(sessionId).first();
  return row.m + 1;
}

function photoMeta(row) {
  return { id: row.id, label: row.label ?? '', at: row.at, seq: row.seq };
}

async function sessionView(env, session, { includeSecret = false } = {}) {
  const messages = await loadMessages(env, session.id);
  const memory = await loadMemory(env, session.id);
  const photosRaw = await loadSessionPhotos(env, session.id);
  const modelRow = await env.DB.prepare('SELECT * FROM dcb_bi_model WHERE session_id = ?1').bind(session.id).first();
  const review = await env.DB.prepare('SELECT score, good, mistakes, missed, comment FROM dcb_reviews WHERE session_id = ?1').bind(session.id).first();
  const ideas = await env.DB.prepare('SELECT strategy, acquaintance, si_notes AS siNotes, next_trials AS nextTrials FROM dcb_ideas WHERE session_id = ?1').bind(session.id).first();
  const budget = await budgetView(env);
  const photos = photosRaw.map((row) => {
    const meta = photoMeta(row);
    if (includeSecret) meta.photoData = row.photo_data;
    return meta;
  });
  const view = {
    id: session.id,
    personaId: session.persona_id,
    personaTitle: session.persona_title,
    mode: session.mode,
    status: session.status,
    biStrategyVersion: session.bi_strategy_version,
    hasPhoto: photos.length > 0 || Boolean(session.photo_data),
    photoCount: photos.length,
    photos,
    startedAt: session.started_at,
    finishedAt: session.finished_at,
    questionCount: session.question_count,
    messages,
    memory,
    biModel: parseModel(modelRow),
    review,
    ideas,
    budget,
  };
  if (includeSecret) view.secretBio = session.secret_bio;
  return view;
}

function personaView(row, { includeSecret = false } = {}) {
  const view = {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hasPhoto: Boolean(row.photo_data),
  };
  if (includeSecret) {
    view.secretBio = row.secret_bio;
    if (row.photo_data) view.photoData = row.photo_data;
  }
  return view;
}

const handlers = {
  'GET /dcb/budget': async (request, env) => {
    await requireDi(request, env);
    return json({ budget: await budgetView(env) });
  },

  'GET /dcb/personas': async (request, env) => {
    const session = await requireDi(request, env);
    const { results } = await env.DB.prepare(
      'SELECT id, title, photo_data, created_at, updated_at FROM dcb_personas WHERE di_user_id = ?1 ORDER BY updated_at DESC',
    ).bind(session.userId).all();
    return json({ personas: results.map((row) => personaView(row)) });
  },

  'POST /dcb/personas': async (request, env) => {
    const session = await requireDi(request, env);
    const body = await readJson(request, { maxBytes: PERSONA_BODY_MAX });
    const title = typeof body.title === 'string' ? body.title.trim() : '';
    const secretBio = typeof body.secretBio === 'string' ? body.secretBio.trim() : '';
    if (!title || title.length > TITLE_MAX) throw new HttpError(400, 'bad_title', 'Нужно короткое название Си.');
    if (!secretBio || secretBio.length > BIO_MAX) throw new HttpError(400, 'bad_bio', 'Нужно описание биографии Си.');
    const photoData = body.photoData !== undefined ? parsePhotoData(body.photoData, { allowNull: true }) : null;
    const id = crypto.randomUUID();
    const at = iso(env);
    await env.DB.prepare(
      'INSERT INTO dcb_personas (id, di_user_id, title, secret_bio, photo_data, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)',
    ).bind(id, session.userId, title, secretBio, photoData, at, at).run();
    return json({
      persona: personaView(
        { id, title, secret_bio: secretBio, photo_data: photoData, created_at: at, updated_at: at },
        { includeSecret: true },
      ),
    }, 201);
  },
};

async function getPersona(request, env, id) {
  const session = await requireDi(request, env);
  const row = await env.DB.prepare('SELECT * FROM dcb_personas WHERE id = ?1 AND di_user_id = ?2').bind(id, session.userId).first();
  if (!row) throw new HttpError(404, 'not_found', 'Си не найден.');
  return json({ persona: personaView(row, { includeSecret: true }) });
}

async function patchPersona(request, env, id) {
  const session = await requireDi(request, env);
  const row = await env.DB.prepare('SELECT * FROM dcb_personas WHERE id = ?1 AND di_user_id = ?2').bind(id, session.userId).first();
  if (!row) throw new HttpError(404, 'not_found', 'Си не найден.');
  const body = await readJson(request, { maxBytes: PERSONA_BODY_MAX });
  const title = body.title !== undefined ? String(body.title).trim() : row.title;
  const secretBio = body.secretBio !== undefined ? String(body.secretBio).trim() : row.secret_bio;
  if (!title || title.length > TITLE_MAX) throw new HttpError(400, 'bad_title', 'Нужно короткое название Си.');
  if (!secretBio || secretBio.length > BIO_MAX) throw new HttpError(400, 'bad_bio', 'Нужно описание биографии Си.');
  const photoData = body.photoData !== undefined
    ? parsePhotoData(body.photoData, { allowNull: true })
    : row.photo_data;
  const titleChanged = title !== row.title;
  const bioChanged = secretBio !== row.secret_bio;
  if (titleChanged || bioChanged) {
    const active = await env.DB.prepare(
      `SELECT id FROM dcb_sessions WHERE persona_id = ?1 AND status IN ('running', 'paused') LIMIT 1`,
    ).bind(id).first();
    if (active) throw new HttpError(409, 'in_session', 'Нельзя менять описание Си во время незавершённого сеанса. Фото можно добавить в сеансе ниже.');
  }
  const at = iso(env);
  await env.DB.prepare('UPDATE dcb_personas SET title = ?1, secret_bio = ?2, photo_data = ?3, updated_at = ?4 WHERE id = ?5')
    .bind(title, secretBio, photoData, at, id).run();
  return json({
    persona: personaView(
      { ...row, title, secret_bio: secretBio, photo_data: photoData, updated_at: at },
      { includeSecret: true },
    ),
  });
}

async function deletePersona(request, env, id) {
  const session = await requireDi(request, env);
  const row = await env.DB.prepare('SELECT id FROM dcb_personas WHERE id = ?1 AND di_user_id = ?2').bind(id, session.userId).first();
  if (!row) throw new HttpError(404, 'not_found', 'Си не найден.');
  const active = await env.DB.prepare(
    `SELECT id FROM dcb_sessions WHERE persona_id = ?1 AND status != 'finished' LIMIT 1`,
  ).bind(id).first();
  if (active) throw new HttpError(409, 'in_session', 'Сначала завершите сеансы с этим Си.');
  await env.DB.prepare('DELETE FROM dcb_personas WHERE id = ?1').bind(id).run();
  return new Response(null, { status: 204 });
}

async function listSessions(request, env) {
  const session = await requireDi(request, env);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.mode, s.status, s.started_at AS startedAt, s.finished_at AS finishedAt, s.question_count AS questionCount,
            p.title AS personaTitle, p.id AS personaId
     FROM dcb_sessions s JOIN dcb_personas p ON p.id = s.persona_id
     WHERE s.di_user_id = ?1 ORDER BY s.started_at DESC LIMIT 100`,
  ).bind(session.userId).all();
  return json({ sessions: results });
}

async function deleteSession(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  // Child tables cascade; reservations have no FK — clean them explicitly.
  await env.DB.batch([
    env.DB.prepare('DELETE FROM dcb_reservations WHERE session_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM dcb_sessions WHERE id = ?1').bind(id),
  ]);
  return json({ deleted: true, id: loaded.id });
}

async function createSession(request, env) {
  const di = await requireDi(request, env);
  const body = await readJson(request);
  const personaId = body.personaId;
  const mode = body.mode === 'large' ? 'large' : 'small';
  const persona = await env.DB.prepare('SELECT * FROM dcb_personas WHERE id = ?1 AND di_user_id = ?2').bind(personaId, di.userId).first();
  if (!persona) throw new HttpError(404, 'not_found', 'Си не найден.');
  const id = crypto.randomUUID();
  const at = iso(env);
  const statements = [
    env.DB.prepare(
      `INSERT INTO dcb_sessions (id, di_user_id, persona_id, mode, status, bi_strategy_version, started_at, question_count)
       VALUES (?1, ?2, ?3, ?4, 'running', ?5, ?6, 0)`,
    ).bind(id, di.userId, personaId, mode, BI_STRATEGY_VERSION, at),
    env.DB.prepare(
      `INSERT INTO dcb_bi_model (session_id, biography, facts_json, hypotheses_json, unknowns_json, updated_at)
       VALUES (?1, '', '[]', '[]', '[]', ?2)`,
    ).bind(id, at),
  ];
  if (persona.photo_data) {
    statements.push(env.DB.prepare(
      `INSERT INTO dcb_session_photos (id, session_id, photo_data, label, created_at, seq)
       VALUES (?1, ?2, ?3, ?4, ?5, 1)`,
    ).bind(crypto.randomUUID(), id, persona.photo_data, 'портрет', at));
  }
  await env.DB.batch(statements);
  const loaded = await loadSession(env, id, di.userId);
  return json({ session: await sessionView(env, loaded, { includeSecret: true }) }, 201);
}

async function addSessionPhoto(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  if (loaded.status === 'finished') throw new HttpError(409, 'finished', 'Сеанс завершён — фото добавить нельзя.');
  const body = await readJson(request, { maxBytes: PERSONA_BODY_MAX });
  const photoData = parsePhotoData(body.photoData);
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, LABEL_MAX) : '';
  const countRow = await env.DB.prepare('SELECT COUNT(*) AS n FROM dcb_session_photos WHERE session_id = ?1').bind(id).first();
  if (Number(countRow.n) >= MAX_SESSION_PHOTOS) {
    throw new HttpError(400, 'photo_limit', `В одном сеансе не больше ${MAX_SESSION_PHOTOS} фото.`);
  }
  const at = iso(env);
  const seq = await nextPhotoSeq(env, id);
  const photoId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO dcb_session_photos (id, session_id, photo_data, label, created_at, seq)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(photoId, id, photoData, label, at, seq).run();
  const next = await loadSession(env, id, di.userId);
  return json({
    session: await sessionView(env, next, { includeSecret: true }),
    photo: { id: photoId, label, at, seq, photoData },
  }, 201);
}

async function getSession(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  return json({ session: await sessionView(env, loaded, { includeSecret: true }) });
}

async function setStatus(request, env, id, status) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  if (loaded.status === 'finished') throw new HttpError(409, 'finished', 'Сеанс уже завершён.');
  const finishedAt = status === 'finished' ? iso(env) : null;
  await env.DB.prepare('UPDATE dcb_sessions SET status = ?1, finished_at = COALESCE(?2, finished_at) WHERE id = ?3')
    .bind(status, finishedAt, id).run();
  const next = await loadSession(env, id, di.userId);
  return json({ session: await sessionView(env, next, { includeSecret: true }) });
}

async function promoteLarge(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  if (loaded.status === 'finished') throw new HttpError(409, 'finished', 'Сеанс уже завершён.');
  if (loaded.mode === 'large') return json({ session: await sessionView(env, loaded, { includeSecret: true }) });
  await env.DB.prepare(`UPDATE dcb_sessions SET mode = 'large', status = CASE WHEN status = 'paused' THEN 'running' ELSE status END WHERE id = ?1`)
    .bind(id).run();
  const next = await loadSession(env, id, di.userId);
  return json({ session: await sessionView(env, next, { includeSecret: true }) });
}

async function biTurn(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  if (loaded.status !== 'running') throw new HttpError(409, 'not_running', 'Сеанс не идёт. Продолжите или начните новый.');
  const messages = await loadMessages(env, id);
  const modelRow = await env.DB.prepare('SELECT * FROM dcb_bi_model WHERE session_id = ?1').bind(id).first();
  const model = parseModel(modelRow);
  const photosRaw = await loadSessionPhotos(env, id);
  const photosMeta = photosRaw.map((p) => ({ seq: p.seq, label: p.label ?? '' }));
  // Latest photos for multimodal (cost-limited); never secret_bio.
  const imageUrls = photosRaw.slice(-BI_PHOTOS_PER_TURN).map((p) => p.photo_data);
  const prompt = buildBiPrompt({
    mode: loaded.mode,
    messages,
    model,
    hasPhoto: photosRaw.length > 0,
    photos: photosMeta,
  });
  const { json: reply } = await chatJson(env, {
    sessionId: id,
    speaker: 'bi',
    system: prompt.system,
    user: prompt.user,
    imageDataUrl: imageUrls.length ? imageUrls : null,
  });
  const utterance = typeof reply.utterance === 'string' ? reply.utterance.trim() : '';
  if (!utterance || utterance.length > TEXT_MAX) throw new HttpError(502, 'model_bad_json', 'Би не дал понятной реплики.');
  const facts = asStringArray(reply.facts);
  const hypotheses = asStringArray(reply.hypotheses);
  const unknowns = asStringArray(reply.unknowns);
  const biography = typeof reply.biography === 'string' ? reply.biography.trim().slice(0, TEXT_MAX) : model.biography;
  const at = iso(env);
  const seq = await nextSeq(env, id);
  const messageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO dcb_messages (id, session_id, speaker, text, created_at, seq) VALUES (?1, ?2, \'bi\', ?3, ?4, ?5)',
    ).bind(messageId, id, utterance, at, seq),
    env.DB.prepare(
      `UPDATE dcb_bi_model SET biography = ?1, facts_json = ?2, hypotheses_json = ?3, unknowns_json = ?4, updated_at = ?5 WHERE session_id = ?6`,
    ).bind(biography, JSON.stringify(facts), JSON.stringify(hypotheses), JSON.stringify(unknowns), at, id),
    env.DB.prepare('UPDATE dcb_sessions SET question_count = question_count + 1 WHERE id = ?1').bind(id),
  ]);
  const next = await loadSession(env, id, di.userId);
  return json({ session: await sessionView(env, next, { includeSecret: true }), message: { id: messageId, speaker: 'bi', text: utterance, at, seq } });
}

async function siReply(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  if (loaded.status !== 'running') throw new HttpError(409, 'not_running', 'Сеанс не идёт.');
  const messages = await loadMessages(env, id);
  if (!messages.length || messages.at(-1).speaker !== 'bi') {
    throw new HttpError(409, 'wait_bi', 'Сначала ход Би.');
  }
  const memory = await loadMemory(env, id);
  const memoryFacts = memory.map((m) => m.fact);
  // Si path: secret_bio is intentionally included only here.
  const prompt = buildSiPrompt({
    mode: loaded.mode,
    secretBio: loaded.secret_bio,
    memoryFacts,
    messages,
  });
  const { json: reply } = await chatJson(env, { sessionId: id, speaker: 'si', system: prompt.system, user: prompt.user });
  const utterance = typeof reply.utterance === 'string' ? reply.utterance.trim() : '';
  if (!utterance || utterance.length > TEXT_MAX) throw new HttpError(502, 'model_bad_json', 'Си не дал понятной реплики.');
  let newFacts = loaded.mode === 'large' ? asStringArray(reply.new_facts) : [];
  if (newFacts.length) {
    const known = [loaded.secret_bio, ...memoryFacts];
    const checkPrompt = buildContradictionPrompt({ knownFacts: known, newFacts });
    try {
      const { json: check } = await chatJson(env, { sessionId: id, speaker: 'check', system: checkPrompt.system, user: checkPrompt.user });
      if (check.ok === false) newFacts = [];
    } catch {
      newFacts = [];
    }
  }
  const at = iso(env);
  const seq = await nextSeq(env, id);
  const messageId = crypto.randomUUID();
  const statements = [
    env.DB.prepare(
      'INSERT INTO dcb_messages (id, session_id, speaker, text, created_at, seq) VALUES (?1, ?2, \'si\', ?3, ?4, ?5)',
    ).bind(messageId, id, utterance, at, seq),
  ];
  for (const fact of newFacts) {
    statements.push(env.DB.prepare(
      `INSERT INTO dcb_persona_memory (id, persona_id, session_id, fact, source, created_at)
       VALUES (?1, ?2, ?3, ?4, 'from_si', ?5)`,
    ).bind(crypto.randomUUID(), loaded.persona_id, id, fact.slice(0, 500), at));
  }
  await env.DB.batch(statements);
  const next = await loadSession(env, id, di.userId);
  return json({ session: await sessionView(env, next, { includeSecret: true }), message: { id: messageId, speaker: 'si', text: utterance, at, seq }, savedFacts: newFacts });
}

async function saveReview(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  if (loaded.status !== 'finished') throw new HttpError(409, 'not_finished', 'Оценку можно сохранить после завершения сеанса.');
  const body = await readJson(request);
  const score = Number(body.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new HttpError(400, 'bad_score', 'Оценка — число от 1 до 5.');
  const field = (name) => (typeof body[name] === 'string' ? body[name].trim().slice(0, TEXT_MAX) : '');
  const at = iso(env);
  await env.DB.prepare(
    `INSERT INTO dcb_reviews (session_id, score, good, mistakes, missed, comment, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
     ON CONFLICT(session_id) DO UPDATE SET score = excluded.score, good = excluded.good, mistakes = excluded.mistakes,
       missed = excluded.missed, comment = excluded.comment, updated_at = excluded.updated_at`,
  ).bind(id, score, field('good'), field('mistakes'), field('missed'), field('comment'), at).run();
  const next = await loadSession(env, id, di.userId);
  return json({ session: await sessionView(env, next, { includeSecret: true }) });
}

async function saveIdeas(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  if (loaded.status !== 'finished') throw new HttpError(409, 'not_finished', 'Идеи можно сохранить после завершения сеанса.');
  const body = await readJson(request);
  const field = (name) => (typeof body[name] === 'string' ? body[name].trim().slice(0, TEXT_MAX) : '');
  const at = iso(env);
  await env.DB.prepare(
    `INSERT INTO dcb_ideas (session_id, strategy, acquaintance, si_notes, next_trials, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
     ON CONFLICT(session_id) DO UPDATE SET strategy = excluded.strategy, acquaintance = excluded.acquaintance,
       si_notes = excluded.si_notes, next_trials = excluded.next_trials, updated_at = excluded.updated_at`,
  ).bind(id, field('strategy'), field('acquaintance'), field('siNotes'), field('nextTrials'), at).run();
  const next = await loadSession(env, id, di.userId);
  return json({ session: await sessionView(env, next, { includeSecret: true }) });
}

async function exportSession(request, env, id) {
  const di = await requireDi(request, env);
  const loaded = await loadSession(env, id, di.userId);
  const view = await sessionView(env, loaded, { includeSecret: true });
  return json({
    format: 'buddy-dcb-session',
    version: 1,
    exportedAt: iso(env),
    session: view,
  });
}

export async function handleDcb(request, env) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  const key = `${method} ${path}`;
  if (handlers[key]) return handlers[key](request, env);

  let m;
  if ((m = /^GET \/dcb\/personas\/([^/]+)$/.exec(`${method} ${path}`))) return getPersona(request, env, m[1]);
  if ((m = /^PATCH \/dcb\/personas\/([^/]+)$/.exec(`${method} ${path}`))) return patchPersona(request, env, m[1]);
  if ((m = /^DELETE \/dcb\/personas\/([^/]+)$/.exec(`${method} ${path}`))) return deletePersona(request, env, m[1]);
  if (key === 'GET /dcb/sessions') return listSessions(request, env);
  if (key === 'POST /dcb/sessions') return createSession(request, env);
  if ((m = /^GET \/dcb\/sessions\/([^/]+)$/.exec(`${method} ${path}`))) return getSession(request, env, m[1]);
  if ((m = /^DELETE \/dcb\/sessions\/([^/]+)$/.exec(`${method} ${path}`))) return deleteSession(request, env, m[1]);
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/pause$/.exec(`${method} ${path}`))) return setStatus(request, env, m[1], 'paused');
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/resume$/.exec(`${method} ${path}`))) return setStatus(request, env, m[1], 'running');
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/finish$/.exec(`${method} ${path}`))) return setStatus(request, env, m[1], 'finished');
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/promote$/.exec(`${method} ${path}`))) return promoteLarge(request, env, m[1]);
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/photos$/.exec(`${method} ${path}`))) return addSessionPhoto(request, env, m[1]);
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/bi$/.exec(`${method} ${path}`))) return biTurn(request, env, m[1]);
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/si$/.exec(`${method} ${path}`))) return siReply(request, env, m[1]);
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/review$/.exec(`${method} ${path}`))) return saveReview(request, env, m[1]);
  if ((m = /^POST \/dcb\/sessions\/([^/]+)\/ideas$/.exec(`${method} ${path}`))) return saveIdeas(request, env, m[1]);
  if ((m = /^GET \/dcb\/sessions\/([^/]+)\/export$/.exec(`${method} ${path}`))) return exportSession(request, env, m[1]);

  return json({ error: 'not_found', message: 'Нет такого адреса.' }, 404);
}

// Exported for isolation unit tests without HTTP.
export const __test = { buildBiPrompt, buildSiPrompt, BI_STRATEGY_VERSION };
