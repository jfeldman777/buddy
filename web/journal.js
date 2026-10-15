// Journal of Bi's acts. Pure functions without DOM or storage, so the rules are testable in Node.
// Each entry keeps four parts apart: Bi's explanation, facts recorded by the program,
// the D1–D7 compliance check, and the person's rating. Bi's words never go into the facts.

export const DECLARATION_IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];
export const MAX_COMMENT_LENGTH = 500;
export const EXPORT_FORMAT = 'buddy-journal';
export const EXPORT_VERSION = 1;

export const statusLabels = {
  kept: 'соблюдено',
  violated: 'нарушено',
  not_applicable: 'не применимо',
  unchecked: 'не проверено',
};

export const checkerLabels = {
  program: 'программа',
  self: 'самооценка Би',
  none: 'никто',
};

export const answerLabels = {
  yes: 'Да',
  no: 'Нет',
  unsure: 'Не знаю',
};

export const RATING_QUESTION = 'Это было кстати?';

const MISMATCH = 'Объяснение Би расходится с действиями, которые записала программа.';

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function buildEntry({ kind, title, explanation, facts = [], result = '', at = new Date().toISOString(), eventId = newId() }) {
  const actions = { eventId, facts: facts.map((fact) => ({ ...fact })), result };
  return {
    event: { eventId, at, kind, title },
    explanation: { eventId, ...explanation },
    actions,
    compliance: { eventId, checkedAt: at, results: checkCompliance(explanation, actions) },
  };
}

function hasFact(actions, type, predicate = () => true) {
  return actions.facts.some((fact) => fact.type === type && predicate(fact));
}

function checkPermissions(explanation, actions) {
  const granted = new Set(actions.facts.filter((f) => f.type === 'permission_granted' || f.type === 'permission_confirmed').map((f) => f.device));
  const used = actions.facts.filter((f) => f.type === 'device_used');
  const unauthorized = used.filter((f) => !granted.has(f.device));
  if (unauthorized.length) {
    return { status: 'violated', basis: `Использовано без разрешения: ${unauthorized.map((f) => deviceLabels[f.device] ?? f.device).join(', ')}.` };
  }
  if (explanation.claims?.usedDevices === false && used.length) return { status: 'violated', basis: MISMATCH };
  if (used.length) return { status: 'kept', basis: 'Микрофон или камера использовались только после разрешения.' };
  return { status: 'kept', basis: 'Программа не зарегистрировала обращений к микрофону и камере.' };
}

function checkPrivacy(explanation, actions) {
  if (hasFact(actions, 'data_sent', (f) => !f.consent)) {
    return { status: 'violated', basis: 'Программа зарегистрировала передачу данных без согласия.' };
  }
  const sent = hasFact(actions, 'data_sent');
  if (explanation.claims?.sentData === false && sent) return { status: 'violated', basis: MISMATCH };
  if (sent) return { status: 'kept', basis: 'Данные переданы только с согласия.' };
  return { status: 'kept', basis: 'Программа не зарегистрировала передачи данных разработчику.' };
}

export function checkCompliance(explanation = {}, actions = { facts: [] }) {
  const referenced = new Set(explanation.declarations ?? []);
  const selfAssessment = explanation.selfAssessment ?? {};
  return DECLARATION_IDS.map((id) => {
    if (id === 'D1') return { id, ...checkPermissions(explanation, actions), checkedBy: 'program' };
    if (id === 'D2') return { id, ...checkPrivacy(explanation, actions), checkedBy: 'program' };
    const self = selfAssessment[id];
    if (self && statusLabels[self.status]) {
      return { id, status: self.status, checkedBy: 'self', basis: self.basis ?? 'Самооценка Би, не программная проверка.' };
    }
    if (referenced.has(id)) {
      return { id, status: 'unchecked', checkedBy: 'none', basis: 'Би ссылается на эту декларацию. Проверить её может только человек.' };
    }
    return { id, status: 'not_applicable', checkedBy: 'none', basis: 'Би не ссылается на эту декларацию.' };
  });
}

export function normalizeRating({ answer, comment = '' } = {}, at = new Date().toISOString()) {
  if (!answerLabels[answer]) return { ok: false, error: 'Выберите «Да», «Нет» или «Не знаю».' };
  const text = String(comment ?? '')
    .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' ? '\n' : ''))
    .trim();
  if (text.length > MAX_COMMENT_LENGTH) return { ok: false, error: `Комментарий длиннее ${MAX_COMMENT_LENGTH} символов.` };
  return { ok: true, rating: { answer, comment: text, at } };
}

const deviceLabels = { microphone: 'микрофон', camera: 'камера' };

export function describeFact(fact) {
  switch (fact.type) {
    case 'saved_on_device':
      return `Сохранено на этом устройстве: ${fact.what}${fact.value ? ` — «${fact.value}»` : ''}.`;
    case 'read_on_device':
      return `Прочитано из памяти этого устройства: ${fact.what}.`;
    case 'speech_requested':
      return `Текст передан на озвучивание голосом «${fact.voice}».`;
    case 'shown_offer':
      return `Показано предложение: ${fact.offer}.`;
    case 'shown_help':
      return `Показана инструкция: ${fact.topic}.`;
    case 'permission_granted':
      return `Получено разрешение: ${deviceLabels[fact.device] ?? fact.device}.`;
    case 'permission_confirmed':
      return `Перед использованием проверено сохранённое разрешение: ${deviceLabels[fact.device] ?? fact.device}.`;
    case 'permission_revoked':
      return `Разрешение отозвано: ${deviceLabels[fact.device] ?? fact.device}.`;
    case 'audio_to_recognizer':
      return 'Звук передан распознаванию речи браузера (Google или Apple), не разработчику.';
    case 'text_inserted':
      return 'Распознанный текст вставлен в поле ответа. Отправить его может только человек.';
    case 'device_used':
      return `Использовано устройство: ${deviceLabels[fact.device] ?? fact.device}.`;
    case 'data_sent':
      return `Отправлено разработчику: ${fact.what} (${fact.consent ? 'с согласия' : 'без согласия'}).`;
    default:
      return `Действие: ${JSON.stringify(fact)}.`;
  }
}

export function joinEntries({ events, explanations, actions, compliance, ratings }) {
  const byId = (items) => new Map(items.map((item) => [item.eventId, item]));
  const parts = { explanation: byId(explanations), actions: byId(actions), compliance: byId(compliance), rating: byId(ratings) };
  return [...events]
    .sort((a, b) => b.at.localeCompare(a.at))
    .map((event) => ({
      ...event,
      explanation: parts.explanation.get(event.eventId) ?? null,
      actions: parts.actions.get(event.eventId) ?? null,
      compliance: parts.compliance.get(event.eventId) ?? null,
      rating: parts.rating.get(event.eventId) ?? null,
    }));
}

export function exportJournal(entries, { declarationsVersion = null, exportedAt = new Date().toISOString() } = {}) {
  const strip = (part) => {
    if (!part) return null;
    const { eventId, ...rest } = part;
    return rest;
  };
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    declarationsVersion,
    entries: entries.map((entry) => ({
      eventId: entry.eventId,
      at: entry.at,
      kind: entry.kind,
      title: entry.title,
      explanation: strip(entry.explanation),
      actions: strip(entry.actions),
      compliance: strip(entry.compliance),
      rating: strip(entry.rating),
    })),
  };
}

export function exportFileName(date = new Date()) {
  return `buddy-journal-${date.toISOString().slice(0, 10)}.json`;
}
