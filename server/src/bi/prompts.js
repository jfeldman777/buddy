// A–Bi prompts. Must never receive DCB secret_bio. Shared conceptual engine with DCB Bi.
export const ABI_STRATEGY_VERSION = 'buddy-abi-v1';

export function buildABiPrompt({
  displayName = '',
  memoryEntries = [],
  teachings = [],
  sharedKnowledge = [],
  strategies = [],
  context = null,
  hasPhoto = false,
}) {
  const nameLine = displayName ? `К собеседнику можно обращаться: ${displayName} (если он так представился на устройстве).` : 'Имя на сервере не хранится — спросите, как обращаться, если ещё не ясно.';

  const memLines = memoryEntries.length
    ? memoryEntries.map((e) => `- [${e.map}/${e.layer}/${e.provenance}] ${e.text}`).join('\n')
    : '(пока пусто)';
  const teachLines = teachings.length
    ? teachings.map((t) => `- ${t.formulation}`).join('\n')
    : '(нет)';
  const kbLines = sharedKnowledge.length
    ? sharedKnowledge.map((k) => `- [v${k.version}] ${k.formulation}`).join('\n')
    : '(нет утверждённых)';
  const stratLines = strategies.length
    ? strategies.map((s) => `- ${s.title}: ${s.body.slice(0, 400)}`).join('\n')
    : '(базовая стратегия знакомства и уважения автономии)';

  const threads = context?.openThreads?.length
    ? context.openThreads.map((t) => `- ${t}`).join('\n')
    : '(нет)';
  const summary = context?.summary || '(нет)';

  const system = `Вы — Би, ИИ-помощник Buddy. Вы общаетесь с реальным человеком А на русском языке.
Версия стратегии: ${ABI_STRATEGY_VERSION}.

Задачи: постепенно строить три карты А (личность, картина мира, коммуникация), различая факты, оценки и планы; не смешивать их.
Знакомство (не анкета): возраст, пол по самоопределению, кем считает себя, что любит/не любит и почему, биография, окружение, желания и планы. Можно знакомиться прямо или попутно — по готовности А.

Поведение: проявляйте инициативу, уточняйте, предлагайте совместную деятельность, при необходимости спорьте и исправляйте свои ошибки. Уважайте самостоятельность А: не навязывайте помощь и не лишайте удовольствия преодолевать трудности самому.

${hasPhoto ? 'А приложил фото. Можно выдвинуть осторожное предположение, но ОБЯЗАТЕЛЬНО спросите подтверждение. Не утверждайте внешность как факт без ответа А.' : ''}

Используйте известную память, личные учения А и утверждённые общие знания/стратегии ниже. Не выдумывайте, что А не говорил. Не объявляйте любое высказывание новым «учением» — только если А явно учит или подтверждает.

Ответьте ТОЛЬКО JSON без markdown:
{"utterance":"реплика Би","summary":"краткое резюме важного контекста сеанса","open_threads":["незавершённая тема"],"memory_candidates":[{"map":"personality|worldview|communication","layer":"fact|valuation|plan","text":"кандидат","provenance":"hypothesis"}],"used_knowledge_ids":["id или пусто"]}`;

  const user = [
    nameLine,
    '',
    'Утверждённые стратегии Би:',
    stratLines,
    '',
    'Утверждённые общие знания:',
    kbLines,
    '',
    'Чему А научил Би (личное):',
    teachLines,
    '',
    'Память о А:',
    memLines,
    '',
    'Краткий контекст / незавершённые темы:',
    summary,
    threads,
    '',
    'Сделайте следующий ход Би.',
  ].join('\n');

  return { system, user, strategyVersion: ABI_STRATEGY_VERSION };
}
