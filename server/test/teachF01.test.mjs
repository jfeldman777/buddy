import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { NOTION_API } from '../src/notion/readPage.js';
import { F01_SPEC } from '../src/teach/f01Spec.js';
import { __test as teachTest } from '../src/teach/f01Cycle.js';
import { tasksForPupilView } from '../src/teach/prompts.js';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  return { token: login.data.session.token, userId: login.data.user.id };
}

function criterion(pass = true) {
  return {
    pass,
    justification: pass ? 'Согласуется с источником.' : 'Нет критерия применения.',
    source_ref: 'инженер-философ / оценка потребителем',
  };
}

function makeTasks(prefix = 'A') {
  return [1, 2, 3].map((n) => ({
    id: `t${n}`,
    prompt: `${prefix}: новая ситуация применения №${n} про оценку продукта философии потребителем`,
    novelty: {
      is_new: true,
      reason: `Содержательно новая ситуация ${prefix}${n}: другой контекст, не пересказ примеров повара/инженера из текста.`,
    },
    rubric: {
      letter: 'опирается на различение прямого/косвенного продукта',
      sense: 'понимает оценку потребителем',
      application: 'применяет к новой ситуации',
      spirit: 'инженер-философский подход',
      model_answer_hint: `Эталон скрытый ${prefix}${n} SECRET_RUBRIC_MARKER`,
      source_ref: 'сравнение трудов; инженер-философ',
    },
  }));
}

function makeGrades(passApp = [true, true, false]) {
  return [1, 2, 3].map((n, i) => ({
    task_id: `t${n}`,
    letter: criterion(true),
    sense: criterion(true),
    application: criterion(passApp[i]),
    spirit: criterion(true),
    error_summary: passApp[i] ? '' : 'Слабое применение',
  }));
}

test('F01 normalizeTasks: требует novelty reason и source_ref', () => {
  assert.throws(
    () => teachTest.normalizeTasks([{ id: 't1', prompt: 'x', novelty: { is_new: true, reason: 'short' }, rubric: { source_ref: 'a' } }]),
    (err) => err.code === 'teach_bad_tasks',
  );
  const ok = teachTest.normalizeTasks(makeTasks());
  assert.equal(ok.length, 3);
  assert.equal(tasksForPupilView(ok)[0].prompt.includes('SECRET_RUBRIC'), false);
  assert.equal('rubric' in tasksForPupilView(ok)[0], false);
});

test('F01 finalStatus: 2/3 application → preliminary_pass', () => {
  const grades = makeGrades([true, true, false]).map((g) => ({
    ...g,
    letter: criterion(true),
    sense: criterion(true),
    application: criterion(g.application.pass),
    spirit: criterion(true),
  }));
  // normalize shape for finalStatus
  const normalized = grades.map((g) => ({
    task_id: g.task_id,
    letter: g.letter,
    sense: g.sense,
    application: g.application,
    spirit: g.spirit,
    error_summary: '',
  }));
  assert.equal(teachTest.finalStatus(normalized), 'experimental_preliminary_pass');
  assert.equal(
    teachTest.finalStatus(normalized.map((g, i) => ({
      ...g,
      application: criterion(i === 0),
    }))),
    'experimental_preliminary_fail',
  );
});

test('POST /admin/teach/f01/run: порядок ролей, эталоны не у Ученика, без записи в память', async () => {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';

  const speakers = [];
  const pupilBodies = [];
  let openaiStep = 0;

  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    const href = String(url);

    if (href.startsWith(NOTION_API)) {
      if (href.includes('/v1/pages/')) {
        return Response.json({
          object: 'page',
          id: F01_SPEC.pageId,
          properties: {
            title: {
              type: 'title',
              title: [{ plain_text: '1.Картина мира: инженерный подход' }],
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
              rich_text: [{
                plain_text: 'Инженер-философ ждёт оценки потребителя. Повар делает прямой продукт. Картина мира — продукт мышления.',
              }],
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

      let content;
      if (speaker === 'teach_examiner_tasks') {
        content = { tasks: makeTasks('R1') };
      } else if (speaker === 'teach_pupil_principles') {
        content = {
          principles: ['Оценка потребителем важнее цеховой похвалы', 'Инженер-философ работает на применение'],
          summary: 'Применимость важнее красоты формулировки',
        };
      } else if (speaker === 'teach_pupil_answers') {
        content = {
          answers: [
            { task_id: 't1', answer: 'Ближе тезис с критерием применения.' },
            { task_id: 't2', answer: 'Потребитель картины мира — тот, кто строит решения.' },
            { task_id: 't3', answer: 'Цеховая оценка философов недостаточна.' },
          ],
        };
      } else if (speaker === 'teach_examiner_grade') {
        // Pass on application for 2/3 → no retest required
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

  assert.equal((await api.call('POST', '/admin/teach/f01/run', { body: {} })).status, 401);

  const userKey = await createAuthenticator();
  const userReg = await registerWithPasskey(api, userKey);
  assert.equal(
    (await api.call('POST', '/admin/teach/f01/run', { token: userReg.data.session.token, body: {} })).status,
    403,
  );

  const memBefore = api.sql('SELECT COUNT(*) AS c FROM bi_memory_entries')[0].c;
  const teachBefore = api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c;
  const kbBefore = api.sql('SELECT COUNT(*) AS c FROM kb_shared')[0].c;

  const { token, userId } = await asAdmin(api);
  const res = await api.call('POST', '/admin/teach/f01/run', { token, body: {} });
  assert.equal(res.status, 200, res.data?.message || JSON.stringify(res.data));
  assert.equal(res.data.experiment, 'Buddy-018-step4-F01');
  assert.match(res.data.disclaimer, /экспериментальн/i);
  assert.equal(res.data.status, 'experimental_preliminary_pass');
  assert.equal(res.data.methodist.fragmentId, 'F01');
  assert.equal(res.data.round1.tasks.length, 3);
  assert.equal(res.data.retest, null);
  assert.deepEqual(res.data.callTrace, [
    'teach_examiner_tasks',
    'teach_pupil_principles',
    'teach_pupil_answers',
    'teach_examiner_grade',
  ]);
  assert.ok(pupilBodies.length >= 1);
  assert.equal(speakers[0], 'teach_examiner_tasks');
  assert.ok(speakers.indexOf('teach_examiner_tasks') < speakers.indexOf('teach_pupil_answers'));

  assert.equal(api.sql('SELECT COUNT(*) AS c FROM bi_memory_entries')[0].c, memBefore);
  assert.equal(api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c, teachBefore);
  assert.equal(api.sql('SELECT COUNT(*) AS c FROM kb_shared')[0].c, kbBefore);

  const audits = api.sql(
    "SELECT action FROM admin_audit WHERE admin_id = ? AND action LIKE 'teach_f01:%'",
    userId,
  );
  assert.equal(audits.length, 1);
  assert.match(audits[0].action, /experimental_preliminary_pass/);
  assert.ok(openaiStep >= 4);
});
