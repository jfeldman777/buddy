export const MAX_BODY_BYTES = 32 * 1024;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

export function now(env) {
  return env.CLOCK ? env.CLOCK() : Date.now();
}

export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function clientIp(request) {
  return request.headers.get('cf-connecting-ip') ?? 'unknown';
}

// CORS only keeps other websites' pages from calling the API from a browser.
// It is not protection: direct requests ignore it. Protection is auth, Turnstile and rate limits.
export function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || !allowedOrigins(env).includes(origin)) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

// Requiring application/json also forces a CORS preflight for browser requests from other sites.
// maxBytes: DCB persona photo upload needs more than the default 32 KB.
export async function readJson(request, { maxBytes = MAX_BODY_BYTES } = {}) {
  if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) {
    throw new HttpError(415, 'json_required', 'Нужен запрос в формате JSON.');
  }
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes) {
    throw new HttpError(413, 'too_large', 'Слишком большой запрос.');
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError(413, 'too_large', 'Слишком большой запрос.');
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_json', 'Тело запроса — не JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, 'bad_json', 'Тело запроса должно быть JSON-объектом.');
  return value;
}