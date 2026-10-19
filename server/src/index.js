// Buddy API: Cloudflare Worker + D1. Auth + DCB + Buddy-011 memory (structured, with consent).
// Local journal and display name stay on the device. Structured memory / chat context need consent.
import { HttpError, json, readJson, corsHeaders, clientIp, now } from './http.js';
import { createSession, authenticate, requireAdmin } from './sessions.js';
import { generateRecoveryCode, formatRecoveryCode, normalizeRecoveryCode, recoveryHmac } from './recovery.js';
import {
  rateLimit, verifyTurnstile, assertRecoverOpen, assertRecoverAttemptAllowed, registerRecoverFailure,
} from './limits.js';
import {
  saveChallenge, takeChallenge, registrationOptions, verifyRegistration, insertCredential,
  authenticationOptions, verifyAuthentication,
} from './passkeys.js';
import { timingSafeEqual } from './crypto.js';
import { handleDcb } from './dcb/routes.js';
import { handleBi } from './bi/routes.js';
import { readNotionPage, FIRST_CHAPTER_PAGE_ID } from './notion/readPage.js';
import { readTuaiIntroCorpus } from './notion/readCorpus.js';
import { runTeachCycle } from './teach/fragmentCycle.js';
import {
  createTeachDispute,
  listTeachDisputes,
  getTeachDispute,
  addDisputeCreatorMessage,
  discussDisputeWithBi,
  resolveTeachDispute,
  createTeachRuling,
  listTeachRulings,
} from './teach/disputes.js';
import { startTeachChain, continueTeachChain, getTeachChain, listTeachChains } from './teach/chain.js';
import {
  startTeachSession,
  ingestTeachSessionPage,
  teachSessionTurn,
  getTeachSession,
  listTeachSessions,
  closeTeachSession,
} from './teach/session.js';
import {
  addCorpusDocument,
  listCorpusDocuments,
  clearCorpusDocuments,
} from './teach/corpusDocuments.js';
import { listFragmentSpecs, DEFAULT_CHAIN_IDS } from './teach/fragmentSpecs.js';

const iso = (env) => new Date(now(env)).toISOString();

async function userView(env, userId, session) {
  const user = await env.DB.prepare(
    `SELECT u.id, u.role, u.created_at,
       (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkeys,
       EXISTS (SELECT 1 FROM recovery_codes r WHERE r.user_id = u.id) AS has_recovery_code
     FROM users u WHERE u.id = ?1`,
  ).bind(userId).first();
  return {
    id: user.id,
    role: user.role,
    createdAt: user.created_at,
    passkeys: user.passkeys,
    hasRecoveryCode: user.has_recovery_code === 1,
    admin: user.role === 'admin' && Boolean(session?.elevated),
  };
}

function insertUser(env, userId) {
  return env.DB.prepare("INSERT INTO users (id, role, status, created_at) VALUES (?1, 'user', 'active', ?2)").bind(userId, iso(env));
}

async function newRecoveryCode(env) {
  const code = generateRecoveryCode();
  return { code, hmac: await recoveryHmac(env, code) };
}

function upsertRecoveryCode(env, userId, hmac) {
  return env.DB.prepare(
    `INSERT INTO recovery_codes (user_id, code_hmac, created_at) VALUES (?1, ?2, ?3)
     ON CONFLICT(user_id) DO UPDATE SET code_hmac = excluded.code_hmac, created_at = excluded.created_at`,
  ).bind(userId, hmac, iso(env));
}

async function anonymous(request, env, group) {
  const ip = clientIp(request);
  await rateLimit(env, 'LIMIT_ANON', `${group}:${ip}`);
  return ip;
}

async function signedIn(request, env) {
  const session = await authenticate(request, env);
  await rateLimit(env, 'LIMIT_USER', session.userId);
  return session;
}

const routes = {
  'GET /health': async () => json({ ok: true, service: 'buddy-api' }),

  'POST /auth/register/options': async (request, env) => {
    const ip = await anonymous(request, env, 'register');
    const body = await readJson(request);
    await verifyTurnstile(env, body.turnstileToken, ip);
    const userId = crypto.randomUUID();
    const options = await registrationOptions(env, userId);
    const challengeId = await saveChallenge(env, { purpose: 'register', challenge: options.challenge, userId });
    return json({ challengeId, options });
  },

  'POST /auth/register/verify': async (request, env) => {
    await anonymous(request, env, 'register');
    const body = await readJson(request);
    const challenge = await takeChallenge(env, body.challengeId, 'register');
    const credential = await verifyRegistration(env, body.response, challenge.challenge);
    const recovery = await newRecoveryCode(env);
    try {
      await env.DB.batch([
        insertUser(env, challenge.user_id),
        insertCredential(env, challenge.user_id, credential),
        upsertRecoveryCode(env, challenge.user_id, recovery.hmac),
      ]);
    } catch {
      throw new HttpError(409, 'passkey_exists', 'Этот passkey уже привязан к учётной записи. Войдите с ним.');
    }
    const session = await createSession(env, challenge.user_id);
    return json({ user: await userView(env, challenge.user_id, session), session, recoveryCode: formatRecoveryCode(recovery.code) }, 201);
  },

  // For devices without passkeys: the recovery code is the only key, and the page warns about it.
  'POST /auth/register/code-only': async (request, env) => {
    const ip = await anonymous(request, env, 'register');
    const body = await readJson(request);
    await verifyTurnstile(env, body.turnstileToken, ip);
    const userId = crypto.randomUUID();
    const recovery = await newRecoveryCode(env);
    await env.DB.batch([insertUser(env, userId), upsertRecoveryCode(env, userId, recovery.hmac)]);
    const session = await createSession(env, userId);
    return json({ user: await userView(env, userId, session), session, recoveryCode: formatRecoveryCode(recovery.code) }, 201);
  },

  'POST /auth/login/options': async (request, env) => {
    await anonymous(request, env, 'login');
    const options = await authenticationOptions(env);
    const challengeId = await saveChallenge(env, { purpose: 'login', challenge: options.challenge });
    return json({ challengeId, options });
  },

  'POST /auth/login/verify': async (request, env) => {
    await anonymous(request, env, 'login');
    const body = await readJson(request);
    const challenge = await takeChallenge(env, body.challengeId, 'login');
    const { stored, userVerified } = await verifyAuthentication(env, body.response, challenge.challenge);
    const session = await createSession(env, stored.user_id, { elevated: stored.role === 'admin' && userVerified });
    return json({ user: await userView(env, stored.user_id, session), session });
  },

  'POST /auth/recover': async (request, env) => {
    const ip = await anonymous(request, env, 'recover');
    await assertRecoverOpen(env);
    await assertRecoverAttemptAllowed(env, ip);
    const body = await readJson(request);
    await verifyTurnstile(env, body.turnstileToken, ip);

    const code = normalizeRecoveryCode(body.code);
    const hmac = code ? await recoveryHmac(env, code) : null;
    const row = hmac && await env.DB.prepare(
      `SELECT r.user_id, r.code_hmac, u.role, u.status FROM recovery_codes r JOIN users u ON u.id = r.user_id WHERE r.code_hmac = ?1`,
    ).bind(hmac).first();
    if (!row || !timingSafeEqual(row.code_hmac, hmac)) {
      await registerRecoverFailure(env);
      throw new HttpError(401, 'code_invalid', 'Код не подошёл. Проверьте его и попробуйте ещё раз.');
    }
    if (row.role === 'admin') throw new HttpError(403, 'admin_passkey_only', 'Администратор входит только по passkey.');
    if (row.status !== 'active') throw new HttpError(403, 'blocked', 'Учётная запись заблокирована.');

    // The used code is replaced in the same statement that checks it, so it works exactly once.
    const recovery = await newRecoveryCode(env);
    const replaced = await env.DB.prepare('UPDATE recovery_codes SET code_hmac = ?1, created_at = ?2 WHERE user_id = ?3 AND code_hmac = ?4')
      .bind(recovery.hmac, iso(env), row.user_id, hmac).run();
    if (replaced.meta.changes !== 1) throw new HttpError(401, 'code_invalid', 'Код уже использован.');
    const session = await createSession(env, row.user_id);
    return json({ user: await userView(env, row.user_id, session), session, recoveryCode: formatRecoveryCode(recovery.code) });
  },

  'POST /auth/logout': async (request, env) => {
    const session = await authenticate(request, env);
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(session.tokenHash).run();
    return new Response(null, { status: 204 });
  },

  'GET /me': async (request, env) => {
    const session = await signedIn(request, env);
    return json({ user: await userView(env, session.userId, session) });
  },

  'POST /me/passkeys/options': async (request, env) => {
    const session = await signedIn(request, env);
    const existing = (await env.DB.prepare('SELECT id, transports FROM credentials WHERE user_id = ?1').bind(session.userId).all()).results;
    const options = await registrationOptions(env, session.userId, existing);
    const challengeId = await saveChallenge(env, { purpose: 'add_passkey', challenge: options.challenge, userId: session.userId });
    return json({ challengeId, options });
  },

  'POST /me/passkeys/verify': async (request, env) => {
    const session = await signedIn(request, env);
    const body = await readJson(request);
    const challenge = await takeChallenge(env, body.challengeId, 'add_passkey');
    if (challenge.user_id !== session.userId) throw new HttpError(400, 'challenge_expired', 'Запрос устарел. Попробуйте ещё раз.');
    const credential = await verifyRegistration(env, body.response, challenge.challenge);
    try {
      await insertCredential(env, session.userId, credential).run();
    } catch {
      throw new HttpError(409, 'passkey_exists', 'Этот passkey уже привязан к учётной записи.');
    }
    return json({ user: await userView(env, session.userId, session) }, 201);
  },

  'POST /me/recovery-code': async (request, env) => {
    const session = await signedIn(request, env);
    if (session.role === 'admin') throw new HttpError(403, 'admin_passkey_only', 'Администратору код восстановления не выдаётся.');
    const recovery = await newRecoveryCode(env);
    await upsertRecoveryCode(env, session.userId, recovery.hmac).run();
    return json({ recoveryCode: formatRecoveryCode(recovery.code) });
  },

  'GET /admin/users': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const { results } = await env.DB.prepare(
      `SELECT u.id, u.role, u.status, u.created_at AS createdAt,
         (SELECT COUNT(*) FROM credentials c WHERE c.user_id = u.id) AS passkeys
       FROM users u ORDER BY u.created_at DESC LIMIT 200`,
    ).all();
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)').bind(session.userId, 'list_users', iso(env)).run();
    return json({ users: results });
  },

  // Buddy-018: read one Notion teaching page (admin only). Default = first chapter.
  'GET /admin/notion/page': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const url = new URL(request.url);
    const rawId = url.searchParams.get('id') || FIRST_CHAPTER_PAGE_ID;
    const page = await readNotionPage(env, {
      pageId: rawId,
      sourceUrl: url.searchParams.get('url') || undefined,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `notion_read:${page.pageId}`, iso(env)).run();
    return json(page);
  },

  // Buddy-018 step 3: read all 13 TUAI intro pages (status + text). Admin only.
  'GET /admin/notion/corpus': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const corpus = await readTuaiIntroCorpus(env);
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `notion_corpus:${corpus.corpusId}:${corpus.okCount}/${corpus.pageCount}`, iso(env)).run();
    return json(corpus);
  },

  // Buddy-018 step 5: teach cycle by fragmentId (F01|F02). No memory writes.
  'POST /admin/teach/run': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const fragmentId = String(body?.fragmentId || '').trim();
    const report = await runTeachCycle(env, { fragmentId, adminId: session.userId });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach:${report.fragmentId}:${report.status}`, iso(env)).run();
    return json(report);
  },

  // Step-4 alias → F01
  'POST /admin/teach/f01/run': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const report = await runTeachCycle(env, { fragmentId: 'F01', adminId: session.userId });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach:F01:${report.status}`, iso(env)).run();
    return json(report);
  },

  // Step 6: open dispute journal (immediate). Alias step-5 /ruling → same create.
  'POST /admin/teach/dispute': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const dispute = await createTeachDispute(env, {
      fragmentId: body?.fragmentId,
      taskId: body?.taskId,
      taskPrompt: body?.taskPrompt,
      pupilAnswer: body?.pupilAnswer,
      examinerNote: body?.examinerNote,
      creatorRemark: body?.creatorRemark || body?.creatorRuling,
      sourceRef: body?.sourceRef,
      adminId: session.userId,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach_dispute:${dispute.fragmentId}:${dispute.id}`, iso(env)).run();
    return json({
      dispute,
      note: 'Разногласие сохранено со статусом open. Открытый вопрос — не утверждённое знание. Учтётся в следующих учебных циклах фрагмента.',
    }, 201);
  },

  'GET /admin/teach/disputes': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const url = new URL(request.url);
    const fragmentId = url.searchParams.get('fragmentId') || '';
    const status = url.searchParams.get('status') || '';
    const disputes = await listTeachDisputes(env, {
      fragmentId: fragmentId || undefined,
      status: status || undefined,
    });
    return json({ disputes });
  },

  'GET /admin/teach/dispute': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const id = new URL(request.url).searchParams.get('id') || '';
    return json(await getTeachDispute(env, id));
  },

  'POST /admin/teach/dispute/message': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const msg = await addDisputeCreatorMessage(env, body?.disputeId, {
      body: body?.body,
      kind: body?.kind,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach_dispute_msg:${body?.disputeId}`, iso(env)).run();
    return json({ message: msg }, 201);
  },

  'POST /admin/teach/dispute/discuss': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const result = await discussDisputeWithBi(env, body?.disputeId, {
      creatorMessage: body?.creatorMessage || body?.body,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach_dispute_discuss:${body?.disputeId}`, iso(env)).run();
    return json(result);
  },

  'POST /admin/teach/dispute/resolve': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const result = await resolveTeachDispute(env, body?.disputeId, {
      status: body?.status,
      resolutionNote: body?.resolutionNote,
      formulation: body?.formulation,
      adminId: session.userId,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach_dispute_resolve:${body?.disputeId}:${body?.status}`, iso(env)).run();
    return json({
      ...result,
      note: 'Разногласие закрыто Создателем. Подтверждённый вывод записан в bi_teachings.',
    });
  },

  // Step-5 aliases
  'POST /admin/teach/ruling': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const dispute = await createTeachRuling(env, {
      fragmentId: body?.fragmentId,
      taskId: body?.taskId,
      taskPrompt: body?.taskPrompt,
      pupilAnswer: body?.pupilAnswer,
      examinerNote: body?.examinerNote,
      creatorRuling: body?.creatorRuling,
      sourceRef: body?.sourceRef,
      adminId: session.userId,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach_dispute:${dispute.fragmentId}:${dispute.id}`, iso(env)).run();
    return json({
      ruling: {
        ...dispute,
        creatorRuling: dispute.creatorRemark,
      },
      dispute,
      note: 'Разногласие сохранено (open). Не утверждённое знание до закрытия Создателем.',
    }, 201);
  },

  'GET /admin/teach/rulings': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const fragmentId = new URL(request.url).searchParams.get('fragmentId') || '';
    const rulings = await listTeachRulings(env, fragmentId);
    return json({ fragmentId: rulings[0]?.fragmentId || String(fragmentId).toUpperCase(), rulings });
  },

  // Step 7A: approved chain + one-fragment steps (stop on fail / open dispute).
  'GET /admin/teach/fragments': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    return json({ chain: DEFAULT_CHAIN_IDS, fragments: listFragmentSpecs() });
  },

  'POST /admin/teach/chain/start': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const run = await startTeachChain(env, {
      adminId: session.userId,
      fragmentIds: body?.fragmentIds,
      forceNew: body?.forceNew === true,
    });
    const audit = run.resumed
      ? `teach_chain_resume:${run.id}:${run.resumeFrom || ''}`
      : `teach_chain_start:${run.id}`;
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, audit, iso(env)).run();
    return json({ run }, run.resumed ? 200 : 201);
  },

  'POST /admin/teach/chain/continue': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const result = await continueTeachChain(env, body?.runId, { adminId: session.userId });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(
        session.userId,
        `teach_chain_step:${body?.runId}:${result.run.status}:${result.run.cursorIndex}`,
        iso(env),
      ).run();
    return json(result);
  },

  'GET /admin/teach/chain': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const id = new URL(request.url).searchParams.get('id') || '';
    return json({ run: await getTeachChain(env, id) });
  },

  'GET /admin/teach/chains': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    return json({ runs: await listTeachChains(env) });
  },

  // Step 8A: Creator↔Bi teaching session (corpus then one-by-one tasks).
  'POST /admin/teach/session/start': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const teach = await startTeachSession(env, {
      adminId: session.userId,
      source: body?.source === 'files' ? 'files' : 'notion',
      pageIds: body?.pageIds,
      documentIds: body?.documentIds,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach_session_start:${teach.corpusKind}:${teach.id}`, iso(env)).run();
    return json({ session: teach }, 201);
  },

  'GET /admin/teach/corpus/documents': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const documents = await listCorpusDocuments(env, { adminId: session.userId, withText: false });
    return json({ documents, count: documents.length });
  },

  'POST /admin/teach/corpus/documents': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    // Extracted text from PDF/DOCX can be large (~200k chars).
    const body = await readJson(request, { maxBytes: 700_000 });
    const document = await addCorpusDocument(env, {
      adminId: session.userId,
      filename: body?.filename,
      title: body?.title,
      kind: body?.kind,
      text: body?.text,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach_corpus_add:${document.kind}:${document.id}`, iso(env)).run();
    return json({ document }, 201);
  },

  'POST /admin/teach/corpus/clear': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    await clearCorpusDocuments(env, { adminId: session.userId });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, 'teach_corpus_clear', iso(env)).run();
    return json({ cleared: true });
  },

  'POST /admin/teach/session/ingest': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const result = await ingestTeachSessionPage(env, body?.sessionId);
    return json(result);
  },

  'POST /admin/teach/session/turn': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const result = await teachSessionTurn(env, body?.sessionId, {
      adminId: session.userId,
      text: body?.text,
    });
    await env.DB.prepare('INSERT INTO admin_audit (admin_id, action, created_at) VALUES (?1, ?2, ?3)')
      .bind(session.userId, `teach_session_turn:${body?.sessionId}`, iso(env)).run();
    return json(result);
  },

  'GET /admin/teach/session': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const id = new URL(request.url).searchParams.get('id') || '';
    return json({ session: await getTeachSession(env, id) });
  },

  'GET /admin/teach/sessions': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    return json({ sessions: await listTeachSessions(env, { adminId: session.userId }) });
  },

  'POST /admin/teach/session/close': async (request, env) => {
    const session = await requireAdmin(request, env);
    await rateLimit(env, 'LIMIT_USER', session.userId);
    const body = await request.json().catch(() => ({}));
    const teach = await closeTeachSession(env, body?.sessionId);
    return json({ session: teach });
  },
};

async function cleanup(env) {
  const t = now(env);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM challenges WHERE expires_at <= ?1').bind(t),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?1').bind(t),
    env.DB.prepare('DELETE FROM rate_counters WHERE window_start < ?1').bind(t - 24 * 60 * 60 * 1000),
  ]);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    let response;
    if (request.method === 'OPTIONS') {
      response = new Response(null, { status: 204 });
    } else {
      const path = new URL(request.url).pathname;
      const handler = routes[`${request.method} ${path}`];
      try {
        if (handler) response = await handler(request, env);
        else if (path.startsWith('/dcb')) response = await handleDcb(request, env);
        else if (path.startsWith('/chat')) response = await handleBi(request, env);
        else response = json({ error: 'not_found', message: 'Нет такого адреса.' }, 404);
      } catch (error) {
        if (error instanceof HttpError) {
          response = json({ error: error.code, message: error.message }, error.status);
        } else {
          console.error(error);
          response = json({ error: 'internal', message: 'Ошибка сервера.' }, 500);
        }
      }
    }
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) headers.set(key, value);
    headers.set('Cache-Control', 'no-store');
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
};
