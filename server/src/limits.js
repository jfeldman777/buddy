import { HttpError, now } from './http.js';

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const RECOVER_PER_IP_PER_HOUR = 5;
export const RECOVER_FAILURE_WINDOW_MS = 10 * 60 * 1000;
export const RECOVER_FAILURE_THRESHOLD = 100;
export const RECOVER_PAUSE_MS = 30 * 60 * 1000;

// Cloudflare Rate Limiting binding: short windows (10 or 60 s), per key.
export async function rateLimit(env, binding, key) {
  const limiter = env[binding];
  if (!limiter) return;
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, 'rate_limited', 'Слишком много запросов. Подождите минуту.');
}

// Fixed-window counter in D1, for windows the binding cannot express (per hour). Atomic upsert.
export async function countInWindow(env, key, windowMs) {
  const windowStart = Math.floor(now(env) / windowMs) * windowMs;
  return env.DB.prepare(
    `INSERT INTO rate_counters (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN rate_counters.window_start = excluded.window_start THEN rate_counters.count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  ).bind(key, windowStart).first('count');
}

export async function verifyTurnstile(env, token, ip) {
  if (!env.TURNSTILE_SECRET) throw new HttpError(503, 'unconfigured', 'Сервер не настроен: нет проверки от ботов.');
  if (typeof token !== 'string' || !token || token.length > 2048) {
    throw new HttpError(400, 'turnstile_missing', 'Подтвердите, что вы не робот.');
  }
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET);
  form.append('response', token);
  if (ip !== 'unknown') form.append('remoteip', ip);
  let result = {};
  try {
    const response = await (env.FETCH ?? fetch)(TURNSTILE_URL, { method: 'POST', body: form });
    result = await response.json();
  } catch {
    throw new HttpError(503, 'turnstile_unavailable', 'Проверка от ботов сейчас недоступна. Попробуйте позже.');
  }
  if (!result.success) throw new HttpError(403, 'turnstile_failed', 'Проверка от ботов не пройдена. Обновите страницу и попробуйте ещё раз.');
}

export async function assertRecoverOpen(env) {
  const until = Number(await env.DB.prepare(`SELECT value FROM service_state WHERE key = 'recover_paused_until'`).first('value') ?? 0);
  if (until > now(env)) throw new HttpError(503, 'recover_paused', 'Вход по коду временно приостановлен. Попробуйте через полчаса или войдите по passkey.');
}

export async function assertRecoverAttemptAllowed(env, ip) {
  const count = await countInWindow(env, `recover:${ip}`, 60 * 60 * 1000);
  if (count > RECOVER_PER_IP_PER_HOUR) throw new HttpError(429, 'rate_limited', 'Слишком много попыток входа по коду. Попробуйте через час.');
}

// A burst of failures across the whole service pauses code login for everyone.
export async function registerRecoverFailure(env) {
  const failures = await countInWindow(env, 'recover:failures', RECOVER_FAILURE_WINDOW_MS);
  if (failures >= RECOVER_FAILURE_THRESHOLD) {
    await env.DB.prepare(
      `INSERT INTO service_state (key, value) VALUES ('recover_paused_until', ?1)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).bind(String(now(env) + RECOVER_PAUSE_MS)).run();
  }
}
