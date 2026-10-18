// Prompts for Buddy-018 teach cycle. Roles must not share hidden rubrics with the pupil.

/** Two grading axes (Creator): буква + дух. Sense/application removed. */
export const GRADE_CRITERIA_RULES = `
Критерии — только буква и дух. Критериев «смысл» и «применение» НЕТ — не пишите их.

БУКВА — точное совпадение с формулировкой/термином/различением первоисточника.
Поле letter.certain=true, если буква даёт определённый ответ (да или нет — без сомнения).
Пример: «точка» по букве — не «объект», пока источник сам не отождествил их.
Когда первоисточник явно говорит, что объект и процесс — то же, что точка и линия, это уже буква.

ДУХ — совпадение по смыслу / методу при другой формулировке.
Пример: «добро и зло» ↔ «справедливость»; «справедливо» ≈ «правильно» (пока источник не разводит их).

ВАЖНО: если letter.certain=true — дух НЕ НУЖЕН: поставьте spirit: null.
Дух оценивайте ТОЛЬКО когда буква сомневается (letter.certain=false).
`.trim();

function fragmentBrief(spec) {
  const prereq = Array.isArray(spec.prerequisites) && spec.prerequisites.length
    ? spec.prerequisites.join(', ')
    : '—';
  return [
    `Фрагмент: ${spec.fragmentId} — ${spec.title}`,
    `Программа: ${spec.programVersion}`,
    `Учебная цель: ${spec.learningGoal}`,
    `Понятия: ${spec.concepts.join('; ')}`,
    `Пререквизиты: ${prereq}`,
    `Охват источника: ${spec.sourceScope}`,
    `Тип задачи после изучения: ${spec.taskType}`,
    `Признаки успеха: ${spec.successSigns.join('; ')}`,
  ].join('\n');
}

function rulingsSection(rulingsBlock) {
  const block = String(rulingsBlock || '').trim();
  if (!block) return [];
  return ['', block, ''];
}

export function examinerTasksPrompt(spec, sourceMaterial, rulingsBlock = '') {
  const id = spec.fragmentId;
  const system = `Вы — Экзаменатор учебного эксперимента Buddy (роль логическая, не отдельный сервис).
Вы составляете проверочные задачи ДО любых ответов Ученика. У вас нет доступа к ответам Ученика.

Правила:
- Опирайтесь ТОЛЬКО на учебный материал ${id} и спеку фрагмента ниже. Не привлекайте другие главы ТУАИ.
- Если даны вердикты Создателя — соблюдайте их при составлении задач и эталонов (приоритет над вашими прошлыми оценками).
- Составьте РОВНО 3 новые задачи на применение (не пересказ).
- Каждая задача должна быть содержательно новой: другая ситуация/формулировка, не пересказ абзацев источника и не переименование примеров автора.
- Для каждой задачи дайте novelty: почему она не содержится в источнике (содержательный аргумент, не «другие слова»).
- Для каждой задачи дайте rubric ТОЛЬКО с критериями буква и дух плюс краткий эталон и source_ref.
${GRADE_CRITERIA_RULES}
- Ответьте ТОЛЬКО JSON.`;

  const user = [
    fragmentBrief(spec),
    ...rulingsSection(rulingsBlock),
    `Учебный материал ${id} (первоисточник):`,
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
            letter: 'что проверить по букве (точное совпадение с источником)',
            spirit: 'что проверить по духу (совпадение по смыслу/методу)',
            model_answer_hint: 'краткий эталон',
            source_ref: `цитата или место в материале ${id}`,
          },
        },
      ],
    }, null, 2),
  ].join('\n');

  return { system, user };
}

export function pupilPrinciplesPrompt(spec, sourceMaterial) {
  const id = spec.fragmentId;
  const system = `Вы — Ученик Би в учебном эксперименте Buddy (не обычный чат с А).
Изучите ТОЛЬКО материал ${id}. Сформулируйте основные принципы своими словами.
Не выдумывайте факты вне источника. Не объявляйте, что вы «уже навсегда усвоили» материал.
Ответьте ТОЛЬКО JSON.`;

  const user = [
    fragmentBrief(spec),
    '',
    `Учебный материал ${id}:`,
    '---',
    sourceMaterial,
    '---',
    '',
    'Верните JSON: {"principles":["…"],"summary":"кратко"}',
  ].join('\n');

  return { system, user };
}

export function pupilAnswersPrompt(spec, principles, tasksForPupil) {
  const id = spec.fragmentId;
  const system = `Вы — Ученик Би. Решите задачи самостоятельно, опираясь на изученные принципы ${id}.
Не просите подсказок. Не утверждайте окончательное усвоение.
Ответьте ТОЛЬКО JSON.`;

  const user = [
    `Учебная цель ${id}: ${spec.learningGoal}`,
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

export function examinerGradePrompt(spec, sourceMaterial, tasksWithRubrics, principles, answers, rulingsBlock = '') {
  const id = spec.fragmentId;
  const system = `Вы — Экзаменатор. Оцените решения Ученика (буква; дух — только если буква сомневается), опираясь на первоисточник ${id} и рубрики.
${GRADE_CRITERIA_RULES}
Для letter всегда: pass, certain, justification, source_ref из материала ${id}.
Для spirit: объект с pass/justification/source_ref ТОЛЬКО если letter.certain=false; иначе spirit=null.
Не повышайте оценку без опоры на источник.
Если даны вердикты/разногласия Создателя — они обязательны при оценке.
Задача считается успешной, если (letter.certain=true и letter.pass=true) ИЛИ (letter.certain=false и spirit.pass=true).
Если успешных задач меньше 2 из 3 — needs_retest=true и РОВНО 3 НОВЫЕ задачи (rubric: буква/дух), иначе needs_retest=false и retest_tasks=[].
Ответьте ТОЛЬКО JSON.`;

  const user = [
    fragmentBrief(spec),
    ...rulingsSection(rulingsBlock),
    `Первоисточник ${id}:`,
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
          letter: { pass: true, certain: true, justification: '…', source_ref: '…' },
          spirit: null,
          error_summary: '',
        },
        {
          task_id: 't2',
          letter: { pass: false, certain: false, justification: 'буква сомневается…', source_ref: '…' },
          spirit: { pass: true, justification: 'по смыслу…', source_ref: '…' },
          error_summary: '',
        },
      ],
      needs_retest: false,
      retest_tasks: [],
      overall_note: 'кратко',
    }, null, 2),
  ].join('\n');

  return { system, user };
}

export function examinerGradeRetestPrompt(spec, sourceMaterial, retestTasks, principles, answers, rulingsBlock = '') {
  const id = spec.fragmentId;
  const system = `Вы — Экзаменатор на повторном испытании (единственный ретест).
Те же правила: буква всегда; дух только если letter.certain=false; иначе spirit=null.
${GRADE_CRITERIA_RULES}
Если даны вердикты Создателя — соблюдайте их.
needs_retest всегда false. retest_tasks всегда [].
Ответьте ТОЛЬКО JSON.`;

  const user = [
    fragmentBrief(spec),
    ...rulingsSection(rulingsBlock),
    `Первоисточник ${id}:`,
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
