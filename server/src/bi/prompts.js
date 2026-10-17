// A–Bi prompts. Must never receive DCB secret_bio. Shared conceptual engine with DCB Bi.
export const ABI_STRATEGY_VERSION = 'buddy-abi-v2';

const ROLE_LABEL = { user: 'А', bi: 'Би' };

export function formatTranscript(transcript = []) {
  if (!Array.isArray(transcript) || !transcript.length) return '(пока нет реплик за сегодня на устройстве)';
  return transcript.map((m) => {
    const who = ROLE_LABEL[m.role] || m.role;
    return `${who}: ${m.text}`;
  }).join('\n');
}

export function buildABiPrompt({
  displayName = '',
  memoryEntries = [],
  teachings = [],
  sharedKnowledge = [],
  strategies = [],
  context = null,
  transcript = [],
  lastBiUtterance = '',
  hasPhoto = false,
  notionTeachingBlock = '',
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
  const dialogue = formatTranscript(transcript);
  const lastBi = lastBiUtterance
    || [...transcript].reverse().find((m) => m.role === 'bi')?.text
    || context?.lastUtterance
    || '';

  const notionHint = notionTeachingBlock
    ? 'Если ниже есть блок «Учебный материал из Notion» — текст уже доставлен сервером. Работайте с ним; не говорите, что не умеете открывать ссылки Notion, и не просите вставить тот же текст вручную.'
    : '';

  const system = `Вы — Би, ИИ-помощник Buddy. Вы общаетесь с реальным человеком А на русском языке.
Версия стратегии: ${ABI_STRATEGY_VERSION}.

Задачи: постепенно строить три карты А (личность, картина мира, коммуникация), различая факты, оценки и планы; не смешивать их.
Знакомство (не анкета): возраст, пол по самоопределению, кем считает себя, что любит/не любит и почему, биография, окружение, желания и планы. Можно знакомиться прямо или попутно — по готовности А.

Поведение: проявляйте инициативу, уточняйте, предлагайте совместную деятельность, при необходимости спорьте и исправляйте свои ошибки. Уважайте самостоятельность А: не навязывайте помощь и не лишайте удовольствия преодолевать трудности самому.

У вас есть переписка за сегодня и ваша последняя реплика. Текущее сообщение А — ответ на вашу последнюю реплику (если она есть): разбирайте смысл именно в этой связке, не притворяйтесь, что не помните, о чём только что говорили.

${hasPhoto ? 'А приложил фото. Можно выдвинуть осторожное предположение, но ОБЯЗАТЕЛЬНО спросите подтверждение. Не утверждайте внешность как факт без ответа А.' : ''}
${notionHint}

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
    'Переписка за сегодня (с устройства А; не полный архив на сервере):',
    dialogue,
    '',
    'Ваша последняя реплика Би (на неё отвечает А, если есть текущее сообщение):',
    lastBi || '(ещё не было реплики Би в этом разговоре)',
    '',
    notionTeachingBlock || '',
    notionTeachingBlock ? '' : '',
    'Сделайте следующий ход Би.',
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n');

  return { system, user, strategyVersion: ABI_STRATEGY_VERSION };
}
