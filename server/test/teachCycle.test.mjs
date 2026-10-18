import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { NOTION_API } from '../src/notion/readPage.js';
import { getFragmentSpec, ALLOWED_FRAGMENT_IDS } from '../src/teach/fragmentSpecs.js';
import { __test as teachTest } from '../src/teach/fragmentCycle.js';
import { tasksForPupilView } from '../src/teach/prompts.js';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  return { token: login.data.session.token, userId: login.data.user.id };
}

function criterion(pass = true, sourceRef = 'источник') {
  return {
    pass,
    justification: pass ? 'Согласуется с источником.' : 'Нет критерия применения.',
    source_ref: sourceRef,
  };
}

function makeTasks(prefix = 'A', topic = 'оценку продукта философии потребителем') {
  return [1, 2, 3].map((n) => ({
    id: `t${n}`,
    prompt: `${prefix}: новая ситуация применения №${n} про ${topic}`,
    novelty: {
      is_new: true,
      reason: `Содержательно новая ситуация ${prefix}${n}: другой контекст, не пересказ примеров из текста.`,
    },
    rubric: {
      letter: 'точное совпадение с термином/формулировкой источника',
      spirit: 'совпадение по смыслу/методу при другой формулировке',
      model_answer_hint: `Эталон скрытый ${prefix}${n} SECRET_RUBRIC_MARKER`,
      source_ref: 'якорь в первоисточнике',
    },
  }));
}

function makeGrades(passTask = [true, true, false], sourceRef = 'источник') {
  return [1, 2, 3].map((n, i) => {
    const ok = passTask[i];
    // Mix: decisive letter when ok; uncertain letter + spirit when fail path needs spirit
    if (ok) {
      return {
        task_id: `t${n}`,
        letter: { ...criterion(true, sourceRef), certain: true },
        spirit: null,
        error_summary: '',
      };
    }
    return {
      task_id: `t${n}`,
      letter: { ...criterion(false, sourceRef), certain: false },
      spirit: criterion(false, sourceRef),
      error_summary: 'Слабый дух',
    };
  });
}

function installTeachMocks(api, {
  spec,
  title,
  paragraph,
  taskTopic,
  principles,
  answers,
}) {
  const speakers = [];
  const pupilBodies = [];
  let openaiStep = 0;
  const realFetch = api.env.FETCH;
  let requestedPageId = null;

  api.env.FETCH = async (url, init) => {
    const href = String(url);

    if (href.startsWith(NOTION_API)) {
      if (href.includes('/v1/pages/')) {
        const m = href.match(/\/v1\/pages\/([^?/]+)/);
        requestedPageId = m ? decodeURIComponent(m[1]) : null;
        return Response.json({
          object: 'page',
          id: spec.pageId,
          properties: {
            title: {
              type: 'title',
              title: [{ plain_text: title }],
            },
          },
        });
      }
      if (href.includes('/children')) {
        return Response.json({
          object: 'list',
          results: [{
            object: 'block',
            id: 'bbbb0001-0000-0000-0000-000000000001',
            type: 'paragraph',
            has_children: false,
            paragraph: {
              rich_text: [{ plain_text: paragraph }],
            },
          }],
          has_more: false,
          next_cursor: null,
        });
      }
      return Response.json({ message: 'unexpected notion' }, { status: 500 });
    }

    if (href.includes('openai.com')) {
      const body = JSON.parse(init.body);
      const system = body.messages[0].content;
      const user = body.messages[1].content;
      openaiStep += 1;

      let speaker = 'unknown';
      if (/составляете проверочные задачи ДО/i.test(system)) speaker = 'teach_examiner_tasks';
      else if (/Ученик Би в учебном эксперименте/i.test(system) && /основные принципы/i.test(system)) speaker = 'teach_pupil_principles';
      else if (/Решите задачи самостоятельно/i.test(system)) speaker = 'teach_pupil_answers';
      else if (/повторном испытании/i.test(system)) speaker = 'teach_examiner_retest_grade';
      else if (/Оцените решения Ученика/i.test(system)) speaker = 'teach_examiner_grade';
      speakers.push(speaker);

      if (speaker === 'teach_pupil_answers') {
        pupilBodies.push(user);
        assert.doesNotMatch(user, /SECRET_RUBRIC_MARKER/);
        assert.doesNotMatch(user, /model_answer_hint/);
        assert.doesNotMatch(user, /Эталон скрытый/);
      }

      assert.match(`${system}\n${user}`, new RegExp(spec.fragmentId));
      assert.match(`${system}\n${user}`, new RegExp(spec.learningGoal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

      let content;
      if (speaker === 'teach_examiner_tasks') {
        content = { tasks: makeTasks('R1', taskTopic) };
      } else if (speaker === 'teach_pupil_principles') {
        content = principles;
      } else if (speaker === 'teach_pupil_answers') {
        content = { answers };
      } else if (speaker === 'teach_examiner_grade') {
        content = {
          grades: makeGrades([true, true, false]),
          needs_retest: false,
          retest_tasks: [],
          overall_note: 'Достаточно для предварительного экспериментального успеха.',
        };
      } else {
        content = { ok: true };
      }

      return Response.json({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 100, completion_tokens: 80 },
      });
    }

    return realFetch(url, init);
  };

  return {
    speakers,
    pupilBodies,
    getOpenaiStep: () => openaiStep,
    getRequestedPageId: () => requestedPageId,
  };
}

test('fragmentSpecs: F01 и F02 различны; F03 запрещён', () => {
  assert.deepEqual(ALLOWED_FRAGMENT_IDS, ['F01', 'F02']);
  const f01 = getFragmentSpec('F01');
  const f02 = getFragmentSpec('F02');
  assert.notEqual(f01.pageId, f02.pageId);
  assert.notEqual(f01.learningGoal, f02.learningGoal);
  assert.equal(f02.prerequisites.includes('F01'), true);
  assert.throws(
    () => getFragmentSpec('F03'),
    (err) => err.code === 'teach_fragment_not_allowed',
  );
});

test('teach normalizeTasks: требует novelty reason и source_ref', () => {
  assert.throws(
    () => teachTest.normalizeTasks([{ id: 't1', prompt: 'x', novelty: { is_new: true, reason: 'short' }, rubric: { source_ref: 'a' } }]),
    (err) => err.code === 'teach_bad_tasks',
  );
  const ok = teachTest.normalizeTasks(makeTasks());
  assert.equal(ok.length, 3);
  assert.equal(tasksForPupilView(ok)[0].prompt.includes('SECRET_RUBRIC'), false);
  assert.equal('rubric' in tasksForPupilView(ok)[0], false);
});

test('teach finalStatus: 2/3 taskPass (буква или дух) → preliminary_pass', () => {
  const normalized = makeGrades([true, true, false]);
  assert.equal(teachTest.finalStatus(normalized), 'experimental_preliminary_pass');
  assert.equal(teachTest.finalStatus(makeGrades([true, false, false])), 'experimental_preliminary_fail');
});

test('teach normalizeGrades: дух не нужен, если буква certain', () => {
  const ok = teachTest.normalizeGrades([
    {
      task_id: 't1',
      letter: { pass: true, certain: true, justification: 'точное совпадение с кодом', source_ref: '(357)' },
      spirit: null,
    },
    {
      task_id: 't2',
      letter: { pass: false, certain: false, justification: 'буква сомневается', source_ref: '—' },
      spirit: { pass: true, justification: 'по смыслу класс тот же', source_ref: '(357)' },
    },
    {
      task_id: 't3',
      letter: { pass: true, certain: true, justification: 'буква ясна', source_ref: '(468)' },
      spirit: { pass: false, justification: 'игнор', source_ref: 'x' },
    },
  ], ['t1', 't2', 't3']);
  assert.equal(ok[0].spirit, null);
  assert.equal(ok[1].spirit.pass, true);
  assert.equal(ok[2].spirit, null); // certain letter drops spirit
  assert.equal(teachTest.taskPass(ok[0]), true);
  assert.equal(teachTest.taskPass(ok[1]), true);
});

async function runFragmentHttpTest(fragmentId, fixture) {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';

  const spec = getFragmentSpec(fragmentId);
  const mocks = installTeachMocks(api, { spec, ...fixture });

  assert.equal((await api.call('POST', '/admin/teach/run', { body: { fragmentId } })).status, 401);

  const userKey = await createAuthenticator();
  const userReg = await registerWithPasskey(api, userKey);
  assert.equal(
    (await api.call('POST', '/admin/teach/run', { token: userReg.data.session.token, body: { fragmentId } })).status,
    403,
  );

  const memBefore = api.sql('SELECT COUNT(*) AS c FROM bi_memory_entries')[0].c;
  const teachBefore = api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c;
  const kbBefore = api.sql('SELECT COUNT(*) AS c FROM kb_shared')[0].c;

  const { token, userId } = await asAdmin(api);

  if (fragmentId === 'F01') {
    const blocked = await api.call('POST', '/admin/teach/run', { token, body: { fragmentId: 'F03' } });
    assert.equal(blocked.status, 400);
    assert.equal(blocked.data?.error, 'teach_fragment_not_allowed');
  }

  const res = await api.call('POST', '/admin/teach/run', { token, body: { fragmentId } });
  assert.equal(res.status, 200, res.data?.message || JSON.stringify(res.data));
  assert.equal(res.data.experiment, `Buddy-018-step5-${fragmentId}`);
  assert.equal(res.data.fragmentId, fragmentId);
  assert.match(res.data.disclaimer, /экспериментальн/i);
  assert.equal(res.data.status, 'experimental_preliminary_pass');
  assert.equal(res.data.methodist.fragmentId, fragmentId);
  assert.equal(res.data.methodist.learningGoal, spec.learningGoal);
  assert.equal(res.data.source.pageId, spec.pageId);
  assert.equal(mocks.getRequestedPageId(), spec.pageId);
  assert.equal(res.data.round1.tasks.length, 3);
  assert.equal(res.data.retest, null);
  assert.deepEqual(res.data.callTrace, [
    'teach_examiner_tasks',
    'teach_pupil_principles',
    'teach_pupil_answers',
    'teach_examiner_grade',
  ]);
  assert.ok(mocks.pupilBodies.length >= 1);
  assert.equal(mocks.speakers[0], 'teach_examiner_tasks');
  assert.ok(mocks.speakers.indexOf('teach_examiner_tasks') < mocks.speakers.indexOf('teach_pupil_answers'));

  assert.equal(api.sql('SELECT COUNT(*) AS c FROM bi_memory_entries')[0].c, memBefore);
  assert.equal(api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c, teachBefore);
  assert.equal(api.sql('SELECT COUNT(*) AS c FROM kb_shared')[0].c, kbBefore);

  const audits = api.sql(
    'SELECT action FROM admin_audit WHERE admin_id = ? AND action LIKE ?',
    userId,
    `teach:${fragmentId}:%`,
  );
  assert.equal(audits.length, 1);
  assert.match(audits[0].action, /experimental_preliminary_pass/);
  assert.ok(mocks.getOpenaiStep() >= 4);
}

test('POST /admin/teach/run F01: порядок ролей, эталоны не у Ученика, без записи в память', async () => {
  await runFragmentHttpTest('F01', {
    title: '1.Картина мира: инженерный подход',
    paragraph: 'Инженер-философ ждёт оценки потребителя. Повар делает прямой продукт. Картина мира — продукт мышления.',
    taskTopic: 'оценку продукта философии потребителем',
    principles: {
      principles: ['Оценка потребителем важнее цеховой похвалы', 'Инженер-философ работает на применение'],
      summary: 'Применимость важнее красоты формулировки',
    },
    answers: [
      { task_id: 't1', answer: 'Ближе тезис с критерием применения.' },
      { task_id: 't2', answer: 'Потребитель картины мира — тот, кто строит решения.' },
      { task_id: 't3', answer: 'Цеховая оценка философов недостаточна.' },
    ],
  });
});

test('POST /admin/teach/run F02: свой материал и цель, эталоны не у Ученика, без записи в память', async () => {
  await runFragmentHttpTest('F02', {
    title: '2.Трудные вопросы',
    paragraph: 'Четыре класса: (468) понимание, (357) оптимальность устройства, (246) правильное поведение, (135) выбор. Не путать 357 и 246.',
    taskTopic: 'классификацию нового трудного вопроса',
    principles: {
      principles: ['Ровно четыре класса с кодами', '357 — устройство, 246 — поведение'],
      summary: 'Классифицировать вопрос по четырём кодам источника',
    },
    answers: [
      { task_id: 't1', answer: 'Это (468): вопрос о понимании смысла.' },
      { task_id: 't2', answer: 'Это (357): как лучше устроить механизм.' },
      { task_id: 't3', answer: 'Это (135): выбор между вариантами.' },
    ],
  });
});

test('POST /admin/teach/f01/run: алиас шага 4 всё ещё работает', async () => {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';
  const spec = getFragmentSpec('F01');
  installTeachMocks(api, {
    spec,
    title: '1.Картина мира',
    paragraph: 'Инженер-философ и картина мира.',
    taskTopic: 'инженер-философию',
    principles: { principles: ['Применение'], summary: 'ok' },
    answers: [
      { task_id: 't1', answer: 'a' },
      { task_id: 't2', answer: 'b' },
      { task_id: 't3', answer: 'c' },
    ],
  });
  const { token } = await asAdmin(api);
  const res = await api.call('POST', '/admin/teach/f01/run', { token, body: {} });
  assert.equal(res.status, 200, res.data?.message || JSON.stringify(res.data));
  assert.equal(res.data.fragmentId, 'F01');
  assert.equal(res.data.experiment, 'Buddy-018-step5-F01');
});
