import { randomBytes, toBase64Url, sha256Hex } from './crypto.js';
import { HttpError, now } from './http.js';

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const ADMIN_SESSION_MS = 12 * 60 * 60 * 1000;
const SLIDE_EVERY_MS = 24 * 60 * 60 * 1000;

// Elevated sessions are the only ones that open /admin/*: created by a passkey login with user verification
// by an account whose role was admin at that moment. They last 12 hours and do not slide.
export async function createSession(env, userId, { elevated = false } = {}) {
  const token = toBase64Url(randomBytes(32));
  const t = now(env);
  const expiresAt = t + (elevated ? ADMIN_SESSION_MS : SESSION_MS);
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash, user_id, elevated, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)',
  ).bind(await sha256Hex(token), userId, elevated ? 1 : 0, new Date(t).toISOString(), expiresAt, t).run();
  return { token, expiresAt: new Date(expiresAt).toISOString(), elevated };
}

function bearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

export async function authenticate(request, env) {
  const token = bearerToken(request);
  if (!token) throw new HttpError(401, 'unauthorized', 'Нужно войти.');
  const tokenHash = await sha256Hex(token);
  const session = await env.DB.prepare(
    `SELECT s.user_id, s.elevated, s.expires_at, s.last_seen_at, u.role, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?1`,
  ).bind(tokenHash).first();
  const t = now(env);
  if (!session || session.expires_at <= t) {
    if (session) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?1').bind(tokenHash).run();
    throw new HttpError(401, 'unauthorized', 'Сессия закончилась. Войдите снова.');
  }
  if (session.status !== 'active') throw new HttpError(403, 'blocked', 'Учётная запись заблокирована.');
  if (!session.elevated && t - session.last_seen_at > SLIDE_EVERY_MS) {
    await env.DB.prepare('UPDATE sessions SET expires_at = ?1, last_seen_at = ?2 WHERE token_hash = ?3').bind(t + SESSION_MS, t, tokenHash).run();
  }
  return { userId: session.user_id, role: session.role, elevated: session.elevated === 1, tokenHash };
}

// The role is read from the database on every request, so removing it takes effect immediately.
export async function requireAdmin(request, env) {
  const session = await authenticate(request, env);
  if (session.role !== 'admin' || !session.elevated) {
    throw new HttpError(403, 'admin_only', 'Нужен вход администратора по passkey.');
  }
  return session;
}
