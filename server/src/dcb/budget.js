// Hard $10 purse for DCB trials. Exceeding granted_micros is rejected before any OpenAI call.
import { HttpError, now } from '../http.js';

export const DCB_GRANT_MICROS = 10_000_000; // $10
export const MICROS_PER_DOLLAR = 1_000_000;
export const DEFAULT_OPENAI_MODEL = 'gpt-4o-mini';

// Micros per 1M tokens (input / output). Unknown models use gpt-4o rates so we never under-reserve.
const MODEL_PRICES = {
  'gpt-4o-mini': { version: 'openai-gpt-4o-mini', inputPerMillion: 150_000, outputPerMillion: 600_000 },
  'gpt-4.1-mini': { version: 'openai-gpt-4.1-mini', inputPerMillion: 400_000, outputPerMillion: 1_600_000 },
  'gpt-4.1-nano': { version: 'openai-gpt-4.1-nano', inputPerMillion: 100_000, outputPerMillion: 400_000 },
  'gpt-4o': { version: 'openai-gpt-4o', inputPerMillion: 2_500_000, outputPerMillion: 10_000_000 },
  'gpt-3.5-turbo': { version: 'openai-gpt-3.5-turbo', inputPerMillion: 500_000, outputPerMillion: 1_500_000 },
};

const FALLBACK_PRICE = { version: 'openai-unknown-as-gpt-4o', inputPerMillion: 2_500_000, outputPerMillion: 10_000_000 };

// Kept for tests that import the default table.
export const PRICE_TABLE = { model: DEFAULT_OPENAI_MODEL, ...MODEL_PRICES[DEFAULT_OPENAI_MODEL] };

export function resolvePriceTable(env = {}) {
  const model = String(env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim() || DEFAULT_OPENAI_MODEL;
  const known = MODEL_PRICES[model];
  return known ? { model, ...known } : { model, ...FALLBACK_PRICE };
}

export function estimateCostMicros({ inputTokens, maxOutputTokens }, prices = PRICE_TABLE) {
  const { inputPerMillion, outputPerMillion } = prices;
  return Math.ceil((inputTokens * inputPerMillion + maxOutputTokens * outputPerMillion) / 1_000_000);
}

export function actualCostMicros({ inputTokens, outputTokens }, prices = PRICE_TABLE) {
  const { inputPerMillion, outputPerMillion } = prices;
  return Math.ceil((inputTokens * inputPerMillion + outputTokens * outputPerMillion) / 1_000_000);
}

export async function budgetView(env) {
  const row = await env.DB.prepare('SELECT granted_micros, spent_micros, reserved_micros FROM dcb_budget WHERE id = 1').first();
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
  };
}

// UPDATE…RETURNING so a failed WHERE (no room in the purse) is visible.
export async function reserveStrict(env, sessionId, amountMicros) {
  if (amountMicros <= 0) throw new HttpError(500, 'internal', 'Нулевой резерв.');
  const id = crypto.randomUUID();
  const t = now(env);
  const iso = new Date(t).toISOString();
  const updated = await env.DB.prepare(
    `UPDATE dcb_budget SET reserved_micros = reserved_micros + ?1, updated_at = ?2
     WHERE id = 1 AND spent_micros + reserved_micros + ?1 <= granted_micros
     RETURNING reserved_micros`,
  ).bind(amountMicros, iso).first();
  if (!updated) throw new HttpError(402, 'budget_exhausted', 'Бюджет испытаний DCB исчерпан. Новые вызовы ИИ запрещены.');
  await env.DB.prepare(
    `INSERT INTO dcb_reservations (id, session_id, amount_micros, status, created_at, expires_at)
     VALUES (?1, ?2, ?3, 'active', ?4, ?5)`,
  ).bind(id, sessionId, amountMicros, iso, t + 5 * 60 * 1000).run();
  return { id, amountMicros };
}

export async function settle(env, reservationId, actualMicros, { sessionId, speaker, model, inputTokens, outputTokens }) {
  const iso = new Date(now(env)).toISOString();
  const res = await env.DB.prepare(
    `SELECT amount_micros, status FROM dcb_reservations WHERE id = ?1`,
  ).bind(reservationId).first();
  if (!res || res.status !== 'active') throw new HttpError(500, 'internal', 'Резерв не найден.');
  const charge = Math.min(Math.max(0, actualMicros), res.amount_micros);
  const release = res.amount_micros - charge;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE dcb_budget SET
         reserved_micros = reserved_micros - ?1,
         spent_micros = spent_micros + ?2,
         updated_at = ?3
       WHERE id = 1`,
    ).bind(res.amount_micros, charge, iso),
    env.DB.prepare(`UPDATE dcb_reservations SET status = 'settled' WHERE id = ?1`).bind(reservationId),
    env.DB.prepare(
      `INSERT INTO dcb_usage (id, session_id, reservation_id, speaker, model, input_tokens, output_tokens, cost_micros, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    ).bind(crypto.randomUUID(), sessionId, reservationId, speaker, model, inputTokens, outputTokens, charge, iso),
  ]);
  return { chargeMicros: charge, releasedMicros: release };
}

export async function release(env, reservationId) {
  const res = await env.DB.prepare(
    `SELECT amount_micros, status FROM dcb_reservations WHERE id = ?1`,
  ).bind(reservationId).first();
  if (!res || res.status !== 'active') return;
  const iso = new Date(now(env)).toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE dcb_budget SET reserved_micros = reserved_micros - ?1, updated_at = ?2 WHERE id = 1`,
    ).bind(res.amount_micros, iso),
    env.DB.prepare(`UPDATE dcb_reservations SET status = 'released' WHERE id = ?1`).bind(reservationId),
  ]);
}
