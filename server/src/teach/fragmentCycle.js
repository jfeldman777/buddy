// Buddy-018 step 5: one teach cycle per fragmentId (admin). No memory / DCB / A–Bi chat writes.
import { HttpError } from '../http.js';
import { chatJson } from '../bi/openai.js';
import { readNotionPage } from '../notion/readPage.js';
import { getFragmentSpec, teachDisclaimer } from './fragmentSpecs.js';
import { listTeachDisputes, formatDisputesForExaminer } from './disputes.js';
import {
  examinerTasksPrompt,
  pupilPrinciplesPrompt,
  pupilAnswersPrompt,
  examinerGradePrompt,
  examinerGradeRetestPrompt,
  tasksForPupilView,
} from './prompts.js';

const TEACH_OUT_TOKENS = 1_800;

function criterion(raw) {
  if (!raw || typeof raw !== 'object') {
    return { pass: false, justification: '', source_ref: '' };
  }
  return {
    pass: raw.pass === true,
    justification: String(raw.justification || '').trim(),
    source_ref: String(raw.source_ref || '').trim(),
  };
}

function normalizeTasks(rawTasks) {
  if (!Array.isArray(rawTasks) || rawTasks.length !== 3) {
    throw new HttpError(502, 'teach_bad_tasks', 'Экзаменатор должен вернуть ровно 3 задачи.');
  }
  return rawTasks.map((t, i) => {
    const id = String(t?.id || `t${i + 1}`);
    const prompt = String(t?.prompt || '').trim();
    const novelty = t?.novelty && typeof t.novelty === 'object' ? t.novelty : {};
    const rubric = t?.rubric && typeof t.rubric === 'object' ? t.rubric : {};
    if (!prompt) throw new HttpError(502, 'teach_bad_tasks', `Пустая задача ${id}.`);
    if (novelty.is_new !== true) {
      throw new HttpError(502, 'teach_not_novel', `Задача ${id} не помечена как содержательно новая.`);
    }
    if (!String(novelty.reason || '').trim() || String(novelty.reason).trim().length < 20) {
      throw new HttpError(502, 'teach_not_novel', `Задача ${id}: нужно содержательное обоснование новизны.`);
    }
    if (!String(rubric.source_ref || '').trim()) {
      throw new HttpError(502, 'teach_bad_rubric', `Задача ${id}: в рубрике нужна ссылка на источник.`);
    }
    return {
      id,
      prompt,
      novelty: { is_new: true, reason: String(novelty.reason).trim() },
      rubric: {
        letter: String(rubric.letter || '').trim(),
        spirit: String(rubric.spirit || '').trim(),
        model_answer_hint: String(rubric.model_answer_hint || '').trim(),
        source_ref: String(rubric.source_ref || '').trim(),
      },
    };
  });
}

function normalizeGrades(rawGrades, taskIds) {
  if (!Array.isArray(rawGrades) || rawGrades.length !== taskIds.length) {
    throw new HttpError(502, 'teach_bad_grades', 'Экзаменатор должен оценить каждую задачу.');
  }
  const byId = new Map(rawGrades.map((g) => [String(g?.task_id || ''), g]));
  return taskIds.map((id) => {
    const g = byId.get(id) || rawGrades[taskIds.indexOf(id)];
    const letterRaw = g?.letter && typeof g.letter === 'object' ? g.letter : {};
    const letter = {
      ...criterion(letterRaw),
      certain: letterRaw.certain === true,
    };
    if (!letter.justification || !letter.source_ref) {
      throw new HttpError(502, 'teach_bad_grades', `Оценка ${id}/letter: нужны justification и source_ref.`);
    }

    let spirit = null;
    if (letter.certain) {
      // Spirit not needed when letter is decisive.
      spirit = null;
    } else {
      const spiritRaw = g?.spirit;
      if (spiritRaw == null || typeof spiritRaw !== 'object') {
        throw new HttpError(
          502,
          'teach_bad_grades',
          `Оценка ${id}/spirit: нужна, когда буква сомневается (certain=false).`,
        );
      }
      spirit = criterion(spiritRaw);
      if (!spirit.justification || !spirit.source_ref) {
        throw new HttpError(502, 'teach_bad_grades', `Оценка ${id}/spirit: нужны justification и source_ref.`);
      }
    }

    return {
      task_id: id,
      letter,
      spirit,
      error_summary: String(g?.error_summary || '').trim(),
    };
  });
}

/** Task succeeds by letter when certain; otherwise by spirit. */
function taskPass(g) {
  if (g.letter?.certain) return g.letter.pass === true;
  return g.spirit?.pass === true;
}

function taskPassCount(grades) {
  return grades.filter(taskPass).length;
}

function finalStatus(grades) {
  return taskPassCount(grades) >= 2
    ? 'experimental_preliminary_pass'
    : 'experimental_preliminary_fail';
}

async function loadFragmentSource(env, spec) {
  const page = await readNotionPage(env, {
    pageId: spec.pageId,
    sourceUrl: spec.sourceUrl,
    expandLinkedPages: false,
  });
  if (!page.complete || !String(page.text || '').trim()) {
    throw new HttpError(
      502,
      'teach_source_incomplete',
      `Не удалось полностью прочитать материал ${spec.fragmentId} из Notion.`,
    );
  }
  return {
    title: page.title || spec.title,
    pageId: page.pageId,
    sourceUrl: page.sourceUrl,
    text: page.text,
    charCount: page.text.length,
  };
}

async function callTeach(env, sessionId, role, prompt, trace) {
  // D1 buddy_chat_usage.speaker CHECK allows only bi|extract|teach — role detail stays in trace.
  trace.push(role);
  const { json, usage } = await chatJson(env, {
    sessionId,
    speaker: 'teach',
    system: prompt.system,
    user: prompt.user,
    maxOutputTokens: TEACH_OUT_TOKENS,
  });
  return { json, usage };
}

/**
 * Run one teach cycle for an allowed fragment. Does not write bi_memory / teachings / kb / DCB.
 * @param {object} env
 * @param {{ fragmentId: string, adminId?: string }} opts
 * @returns {Promise<object>} admin-facing report
 */
export async function runTeachCycle(env, { fragmentId, adminId } = {}) {
  const spec = getFragmentSpec(fragmentId);
  const sessionId = `teach-${spec.fragmentId.toLowerCase()}-${crypto.randomUUID()}`;
  const trace = [];
  const usages = [];

  const source = await loadFragmentSource(env, spec);
  const priorDisputes = await listTeachDisputes(env, { fragmentId: spec.fragmentId, limit: 20 });
  const rulingsBlock = formatDisputesForExaminer(priorDisputes);
  const methodist = {
    fragmentId: spec.fragmentId,
    title: spec.title,
    programVersion: spec.programVersion,
    learningGoal: spec.learningGoal,
    sourceScope: spec.sourceScope,
    concepts: spec.concepts,
    prerequisites: spec.prerequisites,
    taskType: spec.taskType,
    successSigns: spec.successSigns,
  };

  // 1) Examiner tasks BEFORE pupil answers
  const tasksCall = await callTeach(
    env,
    sessionId,
    'teach_examiner_tasks',
    examinerTasksPrompt(spec, source.text, rulingsBlock),
    trace,
  );
  usages.push(tasksCall.usage);
  const tasks = normalizeTasks(tasksCall.json.tasks);
  const pupilTaskView = tasksForPupilView(tasks);

  // 2) Pupil principles
  const prinCall = await callTeach(env, sessionId, 'teach_pupil_principles', pupilPrinciplesPrompt(spec, source.text), trace);
  usages.push(prinCall.usage);
  const principles = {
    list: Array.isArray(prinCall.json.principles)
      ? prinCall.json.principles.map((p) => String(p).trim()).filter(Boolean).slice(0, 12)
      : [],
    summary: String(prinCall.json.summary || '').trim(),
  };
  if (!principles.list.length) {
    throw new HttpError(502, 'teach_bad_principles', 'Ученик не сформулировал принципы.');
  }

  // 3) Pupil answers — must not see rubrics or Creator rulings
  const ansPrompt = pupilAnswersPrompt(spec, principles, pupilTaskView);
  if (/model_answer_hint|novelty|source_ref|rubric|Вердикт Создателя/i.test(ansPrompt.user)) {
    throw new HttpError(500, 'teach_leak', 'Внутренняя ошибка: эталоны Экзаменатора попали к Ученику.');
  }
  for (const t of tasks) {
    if (ansPrompt.user.includes(t.rubric.model_answer_hint) && t.rubric.model_answer_hint.length > 12) {
      throw new HttpError(500, 'teach_leak', 'Эталон рубрики не должен попадать Ученику.');
    }
  }
  if (rulingsBlock && ansPrompt.user.includes(rulingsBlock.slice(0, 40))) {
    throw new HttpError(500, 'teach_leak', 'Вердикты Создателя не должны попадать Ученику.');
  }
  const ansCall = await callTeach(env, sessionId, 'teach_pupil_answers', ansPrompt, trace);
  usages.push(ansCall.usage);
  const answers = Array.isArray(ansCall.json.answers) ? ansCall.json.answers : [];

  // 4) Grade
  const gradeCall = await callTeach(
    env,
    sessionId,
    'teach_examiner_grade',
    examinerGradePrompt(spec, source.text, tasks, principles, answers, rulingsBlock),
    trace,
  );
  usages.push(gradeCall.usage);
  const grades1 = normalizeGrades(gradeCall.json.grades, tasks.map((t) => t.id));
  let retest = null;
  let statusGrades = grades1;

  const needRetest = gradeCall.json.needs_retest === true || taskPassCount(grades1) < 2;
  if (needRetest) {
    let retestTasks;
    try {
      retestTasks = normalizeTasks(gradeCall.json.retest_tasks);
    } catch {
      const retryTasksCall = await callTeach(
        env,
        sessionId,
        'teach_examiner_retest_tasks',
        examinerTasksPrompt(spec, source.text, rulingsBlock),
        trace,
      );
      usages.push(retryTasksCall.usage);
      retestTasks = normalizeTasks(retryTasksCall.json.tasks);
    }
    const firstPrompts = new Set(tasks.map((t) => t.prompt));
    if (retestTasks.every((t) => firstPrompts.has(t.prompt))) {
      throw new HttpError(502, 'teach_retest_same', 'Ретест должен содержать новые задачи, не копию первого комплекта.');
    }

    const retestPupilView = tasksForPupilView(retestTasks);
    const retestAnsCall = await callTeach(
      env,
      sessionId,
      'teach_pupil_retest_answers',
      pupilAnswersPrompt(spec, principles, retestPupilView),
      trace,
    );
    usages.push(retestAnsCall.usage);
    const retestAnswers = Array.isArray(retestAnsCall.json.answers) ? retestAnsCall.json.answers : [];

    const retestGradeCall = await callTeach(
      env,
      sessionId,
      'teach_examiner_retest_grade',
      examinerGradeRetestPrompt(spec, source.text, retestTasks, principles, retestAnswers, rulingsBlock),
      trace,
    );
    usages.push(retestGradeCall.usage);
    const retestGrades = normalizeGrades(retestGradeCall.json.grades, retestTasks.map((t) => t.id));
    retest = {
      tasks: retestTasks,
      answers: retestAnswers,
      grades: retestGrades,
      overall_note: String(retestGradeCall.json.overall_note || '').trim(),
    };
    statusGrades = retestGrades;
  }

  const status = finalStatus(statusGrades);
  const costMicros = usages.reduce((s, u) => s + (u?.costMicros || 0), 0);

  return {
    experiment: `Buddy-018-step5-${spec.fragmentId}`,
    fragmentId: spec.fragmentId,
    disclaimer: teachDisclaimer(spec.fragmentId),
    status,
    methodist,
    source: {
      pageId: source.pageId,
      sourceUrl: source.sourceUrl,
      title: source.title,
      charCount: source.charCount,
      scope: spec.sourceScope,
    },
    round1: {
      tasks,
      principles,
      answers,
      grades: grades1,
      overall_note: String(gradeCall.json.overall_note || '').trim(),
    },
    retest,
    creatorRulingsApplied: priorDisputes.length,
    creatorDisputesApplied: priorDisputes.length,
    creatorDisputes: priorDisputes.map((d) => ({
      id: d.id,
      taskId: d.taskId,
      status: d.status,
      creatorRemark: d.creatorRemark,
      createdAt: d.createdAt,
    })),
    creatorRulings: priorDisputes.map((d) => ({
      id: d.id,
      taskId: d.taskId,
      creatorRuling: d.creatorRemark,
      createdAt: d.createdAt,
      status: d.status,
    })),
    callTrace: trace,
    adminId: adminId || null,
    usage: { calls: usages.length, costMicros },
  };
}

/** @deprecated step-4 name — prefer runTeachCycle(env, { fragmentId: 'F01' }) */
export async function runF01Experiment(env, opts = {}) {
  return runTeachCycle(env, { ...opts, fragmentId: 'F01' });
}

export const __test = {
  normalizeTasks,
  normalizeGrades,
  tasksForPupilView,
  finalStatus,
  taskPass,
  taskPassCount,
  getFragmentSpec,
};
