import { HttpError } from '../http.js';
import {
  resolvePriceTable, estimateCostMicros, actualCostMicros, reserveStrict, settle, release,
} from './budget.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
export const MAX_OUTPUT_TOKENS = 500;

function normalizeImages(imageDataUrl) {
  if (!imageDataUrl) return [];
  const list = Array.isArray(imageDataUrl) ? imageDataUrl : [imageDataUrl];
  return list.filter((url) => typeof url === 'string' && url);
}

function estimateInputTokens(system, user, imageDataUrl) {
  const images = normalizeImages(imageDataUrl);
  const imageTokens = images.length * 800;
  const text = typeof user === 'string' ? user : JSON.stringify(user);
  return Math.ceil((system.length + text.length) / 3) + 40 + imageTokens;
}

function userContent(user, imageDataUrl) {
  const images = normalizeImages(imageDataUrl);
  if (!images.length) return user;
  return [
    { type: 'text', text: user },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
  ];
}

function buildChatBody(model, system, user, imageDataUrl) {
  const body = {
    model,
    temperature: 0.7,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userContent(user, imageDataUrl) },
    ],
  };
  if (/^gpt-6/i.test(model)) {
    body.max_completion_tokens = MAX_OUTPUT_TOKENS;
    body.reasoning_effort = 'none';
  } else {
    body.max_tokens = MAX_OUTPUT_TOKENS;
  }
  return body;
}

function extractMessageText(data) {
  const message = data.choices?.[0]?.message;
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  }
  return '';
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

function openaiErrorMessage(status, errText, model) {
  let body = {};
  try {
    body = JSON.parse(errText);
  } catch {
    /* ignore */
  }
  const apiMessage = String(body?.error?.message ?? '');
  const apiCode = String(body?.error?.code ?? body?.error?.type ?? '');

  if (status === 401) {
    return {
      code: 'openai_key',
      message: 'OpenAI отклонил ключ. Проверьте OPENAI_API_KEY в секретах Worker (без кавычек и пробелов) и задайте его снова.',
    };
  }
  if (
    status === 403
    || status === 404
    || /model_not_found|does not exist|do not have access/i.test(`${apiCode} ${apiMessage}`)
  ) {
    return {
      code: 'openai_forbidden',
      message: `У этого ключа нет доступа к модели «${model}». В кабинете OpenAI включите её или задайте OPENAI_MODEL (например gpt-6-luna или gpt-6.1-sol).`,
    };
  }
  if (status === 429) {
    return {
      code: 'openai_quota',
      message: 'OpenAI отказал из‑за лимита или исчерпанной квоты. Проверьте оплату и лимиты в кабинете OpenAI.',
    };
  }
  if (status >= 500) {
    return {
      code: 'openai_unavailable',
      message: 'OpenAI временно недоступен. Попробуйте через минуту.',
    };
  }
  return { code: 'openai_error', message: 'Ошибка вызова OpenAI.' };
}

async function callOnce(env, { prices, system, user, imageDataUrl }) {
  const fetchImpl = env.FETCH ?? fetch;
  const response = await fetchImpl(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildChatBody(prices.model, system, user, imageDataUrl)),
  });
  return response;
}

export async function chatJson(env, { sessionId, speaker, system, user, imageDataUrl = null }) {
  if (!env.OPENAI_API_KEY) throw new HttpError(503, 'unconfigured', 'Сервер не настроен: нет ключа OpenAI.');
  const prices = resolvePriceTable(env);
  const inputTokens = estimateInputTokens(system, user, imageDataUrl);
  const reserveAmount = estimateCostMicros({ inputTokens, maxOutputTokens: MAX_OUTPUT_TOKENS }, prices);
  const reservation = await reserveStrict(env, sessionId, Math.max(reserveAmount, 1));
  let response;
  try {
    response = await callOnce(env, { prices, system, user, imageDataUrl });
  } catch {
    await release(env, reservation.id);
    throw new HttpError(503, 'openai_unavailable', 'OpenAI сейчас недоступен. Попробуйте позже.');
  }
  if (!response.ok) {
    await release(env, reservation.id);
    const errText = await response.text().catch(() => '');
    console.error('OpenAI error', response.status, prices.model, errText.slice(0, 500));
    const { code, message } = openaiErrorMessage(response.status, errText, prices.model);
    throw new HttpError(502, code, message);
  }
  const data = await response.json();
  let content = extractMessageText(data);
  if (!content.trim()) {
    // One retry: empty content sometimes happens with reasoning models.
    try {
      const retry = await callOnce(env, { prices, system, user, imageDataUrl });
      if (retry.ok) {
        const retryData = await retry.json();
        content = extractMessageText(retryData);
        data.usage = retryData.usage ?? data.usage;
      }
    } catch {
      /* keep empty */
    }
  }
  const usage = data.usage ?? {};
  const inTok = Number(usage.prompt_tokens ?? inputTokens);
  const outTok = Number(usage.completion_tokens ?? 0);
  const cost = actualCostMicros({ inputTokens: inTok, outputTokens: outTok }, prices);
  await settle(env, reservation.id, cost, {
    sessionId,
    speaker,
    model: prices.model,
    inputTokens: inTok,
    outputTokens: outTok,
  });
  return { json: parseJsonContent(content), usage: { inputTokens: inTok, outputTokens: outTok, costMicros: cost } };
}
