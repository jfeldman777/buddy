import { HttpError } from '../http.js';
import { PRICE_TABLE, estimateCostMicros, actualCostMicros, reserveStrict, settle, release } from './budget.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const MAX_OUTPUT_TOKENS = 500;

function estimateInputTokens(system, user) {
  return Math.ceil((system.length + user.length) / 3) + 40;
}

function parseJsonContent(text) {
  const trimmed = String(text ?? '').trim();
  const fence = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  const body = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(502, 'model_bad_json', 'Модель вернула ответ не в формате JSON. Попробуйте ещё раз.');
  }
}

export async function chatJson(env, { sessionId, speaker, system, user }) {
  if (!env.OPENAI_API_KEY) throw new HttpError(503, 'unconfigured', 'Сервер не настроен: нет ключа OpenAI.');
  const inputTokens = estimateInputTokens(system, user);
  const reserveAmount = estimateCostMicros({ inputTokens, maxOutputTokens: MAX_OUTPUT_TOKENS });
  const reservation = await reserveStrict(env, sessionId, Math.max(reserveAmount, 1));
  const fetchImpl = env.FETCH ?? fetch;
  let response;
  try {
    response = await fetchImpl(OPENAI_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: PRICE_TABLE.model,
        temperature: 0.7,
        max_tokens: MAX_OUTPUT_TOKENS,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch {
    await release(env, reservation.id);
    throw new HttpError(503, 'openai_unavailable', 'OpenAI сейчас недоступен. Попробуйте позже.');
  }
  if (!response.ok) {
    await release(env, reservation.id);
    const errText = await response.text().catch(() => '');
    console.error('OpenAI error', response.status, errText.slice(0, 500));
    let code = 'openai_error';
    let message = 'Ошибка вызова OpenAI.';
    if (response.status === 401) {
      code = 'openai_key';
      message = 'OpenAI отклонил ключ. Проверьте OPENAI_API_KEY в секретах Worker (без кавычек и пробелов) и задайте его снова.';
    } else if (response.status === 403) {
      code = 'openai_forbidden';
      message = 'У этого ключа нет доступа к нужной модели. В проекте OpenAI включите gpt-4o-mini или выберите другой ключ.';
    } else if (response.status === 429) {
      code = 'openai_quota';
      message = 'OpenAI отказал из‑за лимита или исчерпанной квоты. Проверьте оплату и лимиты в кабинете OpenAI.';
    } else if (response.status >= 500) {
      code = 'openai_unavailable';
      message = 'OpenAI временно недоступен. Попробуйте через минуту.';
    }
    throw new HttpError(502, code, message);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  const usage = data.usage ?? {};
  const inTok = Number(usage.prompt_tokens ?? inputTokens);
  const outTok = Number(usage.completion_tokens ?? 0);
  const cost = actualCostMicros({ inputTokens: inTok, outputTokens: outTok });
  await settle(env, reservation.id, cost, {
    sessionId,
    speaker,
    model: PRICE_TABLE.model,
    inputTokens: inTok,
    outputTokens: outTok,
  });
  return { json: parseJsonContent(content), usage: { inputTokens: inTok, outputTokens: outTok, costMicros: cost } };
}
