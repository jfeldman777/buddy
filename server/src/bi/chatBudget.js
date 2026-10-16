// A–Bi OpenAI purse — separate from DCB $10. Hard cap: never spend above granted_micros.
import { HttpError, now } from '../http.js';
import { resolvePriceTable, estimateCostMicros, actualCostMicros, MICROS_PER_DOLLAR } from '../dcb/budget.js';

// Default for first trials ($1). Override with CHAT_BUDGET_MICROS in Worker vars.
export const DEFAULT_CHAT_GRANT_MICROS = 1_000_000;

export function resolveChatGrantMicros(env = {}) {
  const raw = env.CHAT_BUDGET_MICROS;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CHAT_GRANT_MICROS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
    throw new HttpError(500, 'misconfigured', 'CHAT_BUDGET_MICROS должен быть целым числом микродолларов ≥ 0.');
  }
  return n;
}

/** Align DB granted_micros with configured grant (raise only; never lower spent history silently). */
export async function ensureChatBudget(env) {
  const grant = resolveChatGrantMicros(env);
  const row = await env.DB.prepare(
    'SELECT granted_micros, spent_micros, reserved_micros FROM buddy_chat_budget WHERE id = 1',
  ).first();
  if (!row) throw new HttpError(500, 'internal', 'Нет кошелька общения А–Би.');
  if (row.granted_micros !== grant) {
    // Only increase grant via config, or set if spent+reserved still fit.
    if (grant < row.spent_micros + row.reserved_micros) {
      throw new HttpError(500, 'misconfigured', 'CHAT_BUDGET_MICROS меньше уже потраченного и зарезервированного.');
    }
    const iso = new Date(now(env)).toISOString();
    await env.DB.prepare(
      'UPDATE buddy_chat_budget SET granted_micros = ?1, updated_at = ?2 WHERE id = 1',
    ).bind(grant, iso).run();
  }
  return grant;
}

export async function chatBudgetView(env) {
  await ensureChatBudget(env);
  const row = await env.DB.prepare(
    'SELECT granted_micros, spent_micros, reserved_micros FROM buddy_chat_budget WHERE id = 1',
  ).first();
  const remaining = row.granted_micros - row.spent_micros - row.reserved_micros;
  const prices = resolvePriceTable(env);
  return {
    grantedMicros: row.granted_micros,
    spentMicros: row.spent_micros,
    reservedMicros: row.reserved_micros,
    remainingMicros: remaining,
    grantedUsd: row.granted_micros / MICROS_PER_DOLLAR,
    spentUsd: row.spent_micros / MICROS_PER_DOLLAR,
    remainingUsd: remaining / MICROS_PER_DOLLAR,
    model: prices.model,
    purse: 'buddy_chat',
  };
}

export async function reserveChatStrict(env, sessionId, amountMicros) {
  if (amountMicros <= 0) throw new HttpError(500, 'internal', 'Нулевой резерв.');
  await ensureChatBudget(env);
  const id = crypto.randomUUID();
  const t = now(env);
  const iso = new Date(t).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE buddy_chat_budget SET reserved_micros = reserved_micros + ?1, updated_at = ?2
     WHERE id = 1 AND spent_micros + reserved_micros + ?1 <= granted_micros
     RETURNING reserved_micros`,
  ).bind(amountMicros, iso).first();
  if (!updated) {
    throw new HttpError(402, 'chat_budget_exhausted', 'Бюджет общения А–Би исчерпан. Новые вызовы ИИ запрещены.');
  }
  await env.DB.prepare(
    `INSERT INTO buddy_chat_reservations (id, session_id, amount_micros, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, 'active', ?4, ?5)`,
  ).bind(id, sessionId, amountMicros, iso, t + 5 * 60 * 1000).run();
  return { id, amountMicros };
}

export async function settleChat(env, reservationId, actualMicros, { sessionId, speaker, model, inputTokens, outputTokens }) {
  const iso = new Date(now(env)).toISOString();
  const res = await env.DB.prepare(
    'SELECT amount_micros, status FROM buddy_chat_reservations WHERE id = ?1',
  ).bind(reservationId).first();
  if (!res || res.status !== 'active') throw new HttpError(500, 'internal', 'Резерв общения не найден.');
  const charge = Math.min(Math.max(0, actualMicros), res.amount_micros);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE buddy_chat_budget SET
         reserved_micros = reserved_micros - ?1,
         spent_micros = spent_micros + ?2,
         updated_at = ?3
       WHERE id = 1`,
    ).bind(res.amount_micros, charge, iso),
    env.DB.prepare(`UPDATE buddy_chat_reservations SET status = 'settled' WHERE id = ?1`).bind(reservationId),
    env.DB.prepare(
      `INSERT INTO buddy_chat_usage (id, session_id, reservation_id, speaker, model, input_tokens, output_tokens, cost_micros, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(crypto.randomUUID(), sessionId, reservationId, speaker, model, inputTokens, outputTokens, charge, iso),
  ]);
  return { chargeMicros: charge, releasedMicros: res.amount_micros - charge };
}

export async function releaseChat(env, reservationId) {
  const res = await env.DB.prepare(
    'SELECT amount_micros, status FROM buddy_chat_reservations WHERE id = ?1',
  ).bind(reservationId).first();
  if (!res || res.status !== 'active') return;
  const iso = new Date(now(env)).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'UPDATE buddy_chat_budget SET reserved_micros = reserved_micros - ?1, updated_at = ?2 WHERE id = 1',
    ).bind(res.amount_micros, iso),
    env.DB.prepare(`UPDATE buddy_chat_reservations SET status = 'released' WHERE id = ?1`).bind(reservationId),
  ]);
}

export { estimateCostMicros, actualCostMicros, resolvePriceTable };
