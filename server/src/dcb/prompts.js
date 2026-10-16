// Separate prompt builders. Bi's path must never receive secret_bio — isolation tests enforce this.
// Photo (if any) is intentionally visible to Bi: Di showed it for appearance cues.
export const BI_STRATEGY_VERSION = 'dcb-bi-facts-v2';

const biSystem = (mode, { hasPhoto }) => `Вы — Би, ИИ-помощник Buddy. Вы исследуете собеседника Си через диалог на русском языке.
Слой исследования: факты биографии, люди и связи (версия стратегии ${BI_STRATEGY_VERSION}).
Режим сеанса: ${mode === 'large' ? 'большой — Си может достраивать биографию; проверяйте согласованность' : 'малый — Си отвечает только из известных сведений и не выдумывает'}.

Порядок вопросов (пока не установлено — спрашивайте в первую очередь):
1) пол;
2) возраст (хотя бы приблизительно);
3) как к Си обращаться: имя или как представиться, «ты» или «вы».
Только после этого переходите к другим фактам биографии и людям.

${hasPhoto ? `Ди приложил фото Си. По фото можете выдвинуть предположение о поле и возрасте, но ОБЯЗАТЕЛЬНО спросите подтверждение у Си («похоже, вам около… это так?»). Не утверждайте внешность как факт без ответа Си.` : 'Фото нет — выясняйте пол, возраст и обращение только вопросами.'}

Правила:
- Задавайте короткие ясные вопросы, по одному существенному вопросу за ход.
- Не утверждайте факты, которых Си не подтвердил.
- Отделяйте установленные факты, предположения и неизвестное.
- Ответьте ТОЛЬКО JSON-объектом без markdown:
{"utterance":"ваша реплика Би","facts":["установленный факт"],"hypotheses":["предположение"],"unknowns":["что ещё не ясно"],"biography":"сжатая биография по установленному"}`;

const siSystemSmall = `Вы — Си, человек с заданной биографией. Отвечаете на русском.
Вам дано скрытое описание вашей жизни. Раскрывайте биографию ПОСТЕПЕННО: за одну реплику — небольшой фрагмент, не вываливайте всё сразу.
Если Би спрашивает пол, возраст или как к вам обращаться — ответьте по описанию (или скажите, если там этого нет).
В малом сеансе: отвечайте ТОЛЬКО в пределах описания и уже сказанного вами. Если не знаете — скажите, что не помните или не хотите говорить. Ничего не выдумывайте.
Ответьте ТОЛЬКО JSON-объектом без markdown:
{"utterance":"ваша реплика","new_facts":[]}`;

const siSystemLarge = `Вы — Си, человек с заданной биографией. Отвечаете на русском.
Вам дано скрытое описание и уже установленные факты. Раскрывайте биографию ПОСТЕПЕННО.
Если Би спрашивает пол, возраст или обращение — ответьте согласованно с описанием.
В большом сеансе вы можете достраивать детали жизни, но:
- нельзя противоречить скрытому описанию и уже установленным фактам;
- новые устойчивые сведения перечислите в new_facts коротко.
Ответьте ТОЛЬКО JSON-объектом без markdown:
{"utterance":"ваша реплика","new_facts":["новый факт или пустой массив"]}`;

function dialogueBlock(messages) {
  if (!messages.length) return 'Диалог ещё не начат. Би начинает первым.';
  return messages.map((m) => `${m.speaker === 'bi' ? 'Би' : 'Си'}: ${m.text}`).join('\n');
}

function priorityHints(model) {
  const blob = `${model.facts.join('\n')}\n${model.biography}`.toLowerCase();
  const hasGender = /пол|мужчин|женщин|девушка|парень|\bон\b|\bона\b|male|female/.test(blob);
  const hasAge = /возраст|\d+\s*(лет|год)/.test(blob);
  const hasAddress = /звать|зовут|обращ|на «ты»|на «вы»|меня зовут|имя/.test(blob);
  const missing = [];
  if (!hasGender) missing.push('пол');
  if (!hasAge) missing.push('возраст');
  if (!hasAddress) missing.push('как обращаться (имя, ты/вы)');
  if (!missing.length) return 'Базовые сведения (пол, возраст, обращение) уже есть — можно углублять биографию.';
  return `Сейчас в первую очередь выясните: ${missing.join(', ')}.`;
}

// ONLY for Bi. Do not add secret_bio here. Photo is optional and intentional for Bi.
export function buildBiPrompt({ mode, messages, model, hasPhoto = false }) {
  const state = [
    priorityHints(model),
    '',
    'Установленные факты:',
    ...(model.facts.length ? model.facts.map((f) => `- ${f}`) : ['(пока нет)']),
    'Предположения:',
    ...(model.hypotheses.length ? model.hypotheses.map((f) => `- ${f}`) : ['(пока нет)']),
    'Неясности:',
    ...(model.unknowns.length ? model.unknowns.map((f) => `- ${f}`) : ['(пока нет)']),
    `Текущая биография:\n${model.biography || '(пусто)'}`,
  ].join('\n');
  return {
    system: biSystem(mode, { hasPhoto }),
    user: `${state}\n\nДиалог:\n${dialogueBlock(messages)}\n\nСделайте следующий ход Би.`,
  };
}

// ONLY for Si. secret_bio is required here and must never be passed to buildBiPrompt.
export function buildSiPrompt({ mode, secretBio, memoryFacts, messages }) {
  const memory = memoryFacts.length
    ? `Уже установленные факты:\n${memoryFacts.map((f) => `- ${f}`).join('\n')}`
    : 'Установленных фактов пока нет.';
  return {
    system: mode === 'large' ? siSystemLarge : siSystemSmall,
    user: `Ваше скрытое описание (не цитируйте его целиком, раскрывайте постепенно):\n${secretBio}\n\n${memory}\n\nДиалог:\n${dialogueBlock(messages)}\n\nОтветьте на последнюю реплику Би.`,
  };
}

export function buildContradictionPrompt({ knownFacts, newFacts }) {
  return {
    system: 'Вы проверяете согласованность фактов биографии. Ответьте только JSON: {"ok":true} или {"ok":false,"conflicts":["кратко"]}.',
    user: `Известные факты:\n${knownFacts.map((f) => `- ${f}`).join('\n') || '(нет)'}\n\nНовые факты:\n${newFacts.map((f) => `- ${f}`).join('\n')}`,
  };
}
