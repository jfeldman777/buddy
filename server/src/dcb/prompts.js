// Separate prompt builders. Bi's path must never receive secret_bio — isolation tests enforce this.
export const BI_STRATEGY_VERSION = 'dcb-bi-facts-v1';

const biSystem = (mode) => `Вы — Би, ИИ-помощник Buddy. Вы исследуете собеседника Си через диалог на русском языке.
Слой исследования: факты биографии, люди и связи между ними (версия стратегии ${BI_STRATEGY_VERSION}).
Режим сеанса: ${mode === 'large' ? 'большой — Си может достраивать биографию; проверяйте согласованность' : 'малый — Си отвечает только из своих известных сведений и не выдумывает'}.

Правила:
- Задавайте короткие ясные вопросы, по одному существенному вопросу за ход.
- Не утверждайте факты, которых Си не подтвердил.
- Отделяйте установленные факты, предположения и неизвестное.
- Ответьте ТОЛЬКО JSON-объектом без markdown:
{"utterance":"реплика Си","facts":["установленный факт"],"hypotheses":["предположение"],"unknowns":["что ещё не ясно"],"biography":"сжатая биография по установленному"}`;

const siSystemSmall = `Вы — Си, человек с заданной биографией. Отвечаете на русском.
Вам дано скрытое описание вашей жизни. Раскрывайте биографию ПОСТЕПЕННО: за одну реплику — небольшой фрагмент, не вываливайте всё сразу.
В малом сеансе: отвечайте ТОЛЬКО в пределах описания и уже сказанного вами. Если не знаете — скажите, что не помните или не хотите говорить. Ничего не выдумывайте.
Ответьте ТОЛЬКО JSON-объектом без markdown:
{"utterance":"ваша реплика","new_facts":[]}`;

const siSystemLarge = `Вы — Си, человек с заданной биографией. Отвечаете на русском.
Вам дано скрытое описание и уже установленные факты. Раскрывайте биографию ПОСТЕПЕННО.
В большом сеансе вы можете достраивать детали жизни, но:
- нельзя противоречить скрытому описанию и уже установленным фактам;
- новые устойчивые сведения перечислите в new_facts коротко.
Ответьте ТОЛЬКО JSON-объектом без markdown:
{"utterance":"ваша реплика","new_facts":["новый факт или пустой массив"]}`;

function dialogueBlock(messages) {
  if (!messages.length) return 'Диалог ещё не начат. Би начинает первым.';
  return messages.map((m) => `${m.speaker === 'bi' ? 'Би' : 'Си'}: ${m.text}`).join('\n');
}

// ONLY for Bi. Do not add secret_bio or persona fields here.
export function buildBiPrompt({ mode, messages, model }) {
  const state = [
    'Установленные факты:',
    ...(model.facts.length ? model.facts.map((f) => `- ${f}`) : ['(пока нет)']),
    'Предположения:',
    ...(model.hypotheses.length ? model.hypotheses.map((f) => `- ${f}`) : ['(пока нет)']),
    'Неясности:',
    ...(model.unknowns.length ? model.unknowns.map((f) => `- ${f}`) : ['(пока нет)']),
    `Текущая биография:\n${model.biography || '(пусто)'}`,
  ].join('\n');
  return {
    system: biSystem(mode),
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
