// Prompts for Buddy-018 F01 experimental cycle. Roles must not share hidden rubrics with the pupil.
import { F01_SPEC } from './f01Spec.js';

function f01Brief() {
  return [
    `Фрагмент: ${F01_SPEC.fragmentId} — ${F01_SPEC.title}`,
    `Программа: ${F01_SPEC.programVersion}`,
    `Учебная цель: ${F01_SPEC.learningGoal}`,
    `Понятия: ${F01_SPEC.concepts.join('; ')}`,
    `Охват источника: ${F01_SPEC.sourceScope}`,
    `Тип задачи после изучения: ${F01_SPEC.taskType}`,
    `Признаки успеха: ${F01_SPEC.successSigns.join('; ')}`,
  ].join('\n');
}

export function examinerTasksPrompt(sourceMaterial) {
  const system = `Вы — Экзаменатор учебного эксперимента Buddy (роль логическая, не отдельный сервис).
Вы составляете проверочные задачи ДО любых ответов Ученика. У вас нет доступа к ответам Ученика.

Правила:
- Опирайтесь ТОЛЬКО на учебный материал F01 и спеку фрагмента ниже. Не привлекайте другие главы ТУАИ.
- Составьте РОВНО 3 новые задачи на применение (не пересказ).
- Каждая задача должна быть содержательно новой: другая ситуация/формулировка, не пересказ абзацев источника и не переименование примеров автора.
- Для каждой задачи дайте novelty: почему она не содержится в источнике (содержательный аргумент, не «другие слова»).
- Для каждой задачи дайте rubric с критериями буква/смысл/применение/дух и кратким эталоном хорошего ответа, со ссылкой на место в источнике (цитата или парафраз + якорь).
- Ответьте ТОЛЬКО JSON.`;

  const user = [
    f01Brief(),
    '',
    'Учебный материал F01 (первоисточник):',
    '---',
    sourceMaterial,
    '---',
    '',
    'Верните JSON:',
    JSON.stringify({
      tasks: [
        {
          id: 't1',
          prompt: 'текст задачи',
          novelty: { is_new: true, reason: 'содержательное обоснование новизны' },
          rubric: {
            letter: 'что проверить по букве источника',
            sense: 'понимание',
            application: 'применение',
            spirit: 'дух метода',
            model_answer_hint: 'краткий эталон',
            source_ref: 'цитата или место в материале F01',
          },
        },
      ],
    }, null, 2),
  ].join('\n');

  return { system, user };
}

export function pupilPrinciplesPrompt(sourceMaterial) {
  const system = `Вы — Ученик Би в учебном эксперименте Buddy (не обычный чат с А).
Изучите ТОЛЬКО материал F01. Сформулируйте основные принципы своими словами.
Не выдумывайте факты вне источника. Не объявляйте, что вы «уже навсегда усвоили» материал.
Ответьте ТОЛЬКО JSON.`;

  const user = [
    f01Brief(),
    '',
    'Учебный материал F01:',
    '---',
    sourceMaterial,
    '---',
    '',
    'Верните JSON: {"principles":["…"],"summary":"кратко"}',
  ].join('\n');

  return { system, user };
}

export function pupilAnswersPrompt(principles, tasksForPupil) {
  const system = `Вы — Ученик Би. Решите задачи самостоятельно, опираясь на изученные принципы F01.
Не просите подсказок. Не утверждайте окончательное усвоение.
Ответьте ТОЛЬКО JSON.`;

  const user = [
    `Учебная цель F01: ${F01_SPEC.learningGoal}`,
    '',
    'Ваши принципы (из предыдущего шага):',
    JSON.stringify(principles, null, 2),
    '',
    'Задачи (решите каждую; эталонов и рубрик Экзаменатора у вас нет):',
    JSON.stringify(tasksForPupil, null, 2),
    '',
    'Верните JSON: {"answers":[{"task_id":"t1","answer":"…"}]}',
  ].join('\n');

  return { system, user };
}

export function examinerGradePrompt(sourceMaterial, tasksWithRubrics, principles, answers) {
  const system = `Вы — Экзаменатор. Оцените решения Ученика по четырём критериям, опираясь на первоисточник F01 и заранее составленные рубрики.
Для КАЖДОГО критерия каждой задачи обязательны: pass (bool), justification (обоснование), source_ref (ссылка/цитата из материала F01).
Не повышайте оценку без опоры на источник.
Если применение провалено менее чем в 2 задачах из 3 — set needs_retest=true и предложите РОВНО 3 НОВЫЕ задачи (с novelty и rubric), отличные от первого комплекта.
Если needs_retest=false, поле retest_tasks = [].
Ответьте ТОЛЬКО JSON.`;

  const user = [
    f01Brief(),
    '',
    'Первоисточник F01:',
    '---',
    sourceMaterial,
    '---',
    '',
    'Задачи и рубрики (составлены ДО ответов):',
    JSON.stringify(tasksWithRubrics, null, 2),
    '',
    'Принципы Ученика:',
    JSON.stringify(principles, null, 2),
    '',
    'Ответы Ученика:',
    JSON.stringify(answers, null, 2),
    '',
    'Верните JSON вида:',
    JSON.stringify({
      grades: [
        {
          task_id: 't1',
          letter: { pass: true, justification: '…', source_ref: '…' },
          sense: { pass: true, justification: '…', source_ref: '…' },
          application: { pass: true, justification: '…', source_ref: '…' },
          spirit: { pass: true, justification: '…', source_ref: '…' },
          error_summary: 'если есть ошибки — кратко; иначе пусто',
        },
      ],
      needs_retest: false,
      retest_tasks: [],
      overall_note: 'кратко',
    }, null, 2),
  ].join('\n');

  return { system, user };
}

export function examinerGradeRetestPrompt(sourceMaterial, retestTasks, principles, answers) {
  const system = `Вы — Экзаменатор на повторном испытании (единственный ретест).
Оцените новые ответы по тем же правилам: для каждого критерия — pass, justification, source_ref из материала F01.
needs_retest всегда false. retest_tasks всегда [].
Ответьте ТОЛЬКО JSON.`;

  const user = [
    f01Brief(),
    '',
    'Первоисточник F01:',
    '---',
    sourceMaterial,
    '---',
    '',
    'Задачи ретеста и рубрики:',
    JSON.stringify(retestTasks, null, 2),
    '',
    'Принципы Ученика:',
    JSON.stringify(principles, null, 2),
    '',
    'Ответы Ученика на ретест:',
    JSON.stringify(answers, null, 2),
    '',
    'Верните JSON: {"grades":[...],"needs_retest":false,"retest_tasks":[],"overall_note":"…"}',
  ].join('\n');

  return { system, user };
}

/** Strip rubrics/novelty internals before showing tasks to the pupil. */
export function tasksForPupilView(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map((t, i) => ({
    id: String(t?.id || `t${i + 1}`),
    prompt: String(t?.prompt || '').trim(),
  })).filter((t) => t.prompt);
}
