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
