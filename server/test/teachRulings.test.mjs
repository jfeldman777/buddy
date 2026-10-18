import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { NOTION_API } from '../src/notion/readPage.js';
import { getFragmentSpec } from '../src/teach/fragmentSpecs.js';
import { formatRulingsForExaminer } from '../src/teach/rulings.js';
import { examinerTasksPrompt, pupilAnswersPrompt } from '../src/teach/prompts.js';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  return { token: login.data.session.token, userId: login.data.user.id };
}

test('formatRulingsForExaminer: пусто / с вердиктом', () => {
  assert.equal(formatRulingsForExaminer([]), '');
  const block = formatRulingsForExaminer([{
    createdAt: '2026-10-18T00:00:00.000Z',
    taskId: 't1',
    taskPrompt: 'Классифицируй вопрос',
    pupilAnswer: 'Это (246)',
    examinerNote: 'применение: да',
    creatorRuling: 'Это (357): устройство, не поведение. 357≠246.',
    sourceRef: 'коды (357)(246)',
  }]);
  assert.match(block, /Замечание Создателя|Вердикт Создателя/);
  assert.match(block, /357≠246/);
  assert.match(block, /НЕ утверждённое знание|Открытые разногласия/);
});

test('промпты: вердикты только у Экзаменатора, не у Ученика', () => {
  const spec = getFragmentSpec('F02');
  const rulings = formatRulingsForExaminer([{
    createdAt: 't',
    creatorRuling: 'MARKER_CREATOR_RULING_SECRET не путать 357 и 246',
  }]);
  const exam = examinerTasksPrompt(spec, 'материал F02', rulings);
  assert.match(exam.user, /MARKER_CREATOR_RULING_SECRET/);
  const pupil = pupilAnswersPrompt(spec, { list: ['p'], summary: 's' }, [{ id: 't1', prompt: 'задача' }]);
  assert.doesNotMatch(pupil.user, /MARKER_CREATOR_RULING_SECRET/);
  assert.doesNotMatch(pupil.user, /Вердикт Создателя/);
});

test('POST /admin/teach/ruling + следующий run подмешивает вердикт Экзаменатору', async () => {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';
  const spec = getFragmentSpec('F02');

  const { token, userId } = await asAdmin(api);

  assert.equal((await api.call('POST', '/admin/teach/ruling', { body: { fragmentId: 'F02', creatorRuling: 'x'.repeat(20) } })).status, 401);

  const short = await api.call('POST', '/admin/teach/ruling', {
    token,
    body: { fragmentId: 'F02', creatorRuling: 'коротко' },
  });
  assert.equal(short.status, 400);

  const memBefore = api.sql('SELECT COUNT(*) AS c FROM bi_memory_entries')[0].c;
  const teachBefore = api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c;

  const created = await api.call('POST', '/admin/teach/ruling', {
    token,
    body: {
      fragmentId: 'F02',
      taskId: 't1',
      taskPrompt: 'К какому классу вопрос про устройство механизма?',
      pupilAnswer: 'Это (246) правильное поведение.',
      examinerNote: 'применение: да',
      creatorRuling: 'Ошибка: устройство механизма — класс (357), не (246). 357≠246.',
      sourceRef: '(357) оптимальность устройства',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.ruling.fragmentId, 'F02');
  assert.match(created.data.note, /open|разноглас/i);

  assert.equal(api.sql('SELECT COUNT(*) AS c FROM bi_memory_entries')[0].c, memBefore);
  assert.equal(api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c, teachBefore);
  assert.equal(api.sql('SELECT COUNT(*) AS c FROM teach_rulings')[0].c, 1);

  const listed = await api.call('GET', '/admin/teach/rulings?fragmentId=F02', { token });
  assert.equal(listed.status, 200);
  assert.equal(listed.data.rulings.length, 1);

  const examinerUsers = [];
  const pupilUsers = [];
  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    const href = String(url);
    if (href.startsWith(NOTION_API)) {
      if (href.includes('/v1/pages/')) {
        return Response.json({
          object: 'page',
          id: spec.pageId,
          properties: { title: { type: 'title', title: [{ plain_text: '2.Трудные вопросы' }] } },
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
            paragraph: { rich_text: [{ plain_text: 'Классы (468)(357)(246)(135). 357≠246.' }] },
          }],
          has_more: false,
          next_cursor: null,
        });
      }
      return Response.json({ message: 'unexpected' }, { status: 500 });
    }
    if (href.includes('openai.com')) {
      const body = JSON.parse(init.body);
      const system = body.messages[0].content;
      const user = body.messages[1].content;
      let speaker = 'unknown';
      if (/составляете проверочные задачи ДО/i.test(system)) speaker = 'teach_examiner_tasks';
      else if (/основные принципы/i.test(system)) speaker = 'teach_pupil_principles';
      else if (/Решите задачи самостоятельно/i.test(system)) speaker = 'teach_pupil_answers';
      else if (/Оцените решения Ученика/i.test(system)) speaker = 'teach_examiner_grade';

      if (speaker.startsWith('teach_examiner')) examinerUsers.push(user);
      if (speaker === 'teach_pupil_answers') pupilUsers.push(user);

      let content = { ok: true };
      if (speaker === 'teach_examiner_tasks') {
        content = {
          tasks: [1, 2, 3].map((n) => ({
            id: `t${n}`,
            prompt: `Новая задача ${n} на классификацию вопроса вне текста источника`,
            novelty: { is_new: true, reason: 'Содержательно новая ситуация вне примеров автора из абзаца.' },
            rubric: {
              letter: 'коды',
              spirit: 'дух классов',
              model_answer_hint: `SECRET_RUBRIC_${n}`,
              source_ref: '(357)',
            },
          })),
        };
      } else if (speaker === 'teach_pupil_principles') {
        content = { principles: ['Четыре класса'], summary: 'коды' };
      } else if (speaker === 'teach_pupil_answers') {
        content = {
          answers: [
            { task_id: 't1', answer: 'a' },
            { task_id: 't2', answer: 'b' },
            { task_id: 't3', answer: 'c' },
          ],
        };
      } else if (speaker === 'teach_examiner_grade') {
        content = {
          grades: [1, 2, 3].map((n) => ({
            task_id: `t${n}`,
            letter: { pass: true, certain: true, justification: 'ok', source_ref: 'src' },
            spirit: null,
            error_summary: '',
          })),
          needs_retest: false,
          retest_tasks: [],
          overall_note: 'ok',
        };
      }
      return Response.json({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      });
    }
    return realFetch(url, init);
  };

  const run = await api.call('POST', '/admin/teach/run', { token, body: { fragmentId: 'F02' } });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.creatorRulingsApplied, 1);
  assert.ok(examinerUsers.some((u) => /357≠246|устройство механизма — класс \(357\)/i.test(u)));
  assert.ok(pupilUsers.every((u) => !/Вердикт Создателя|MARKER|357≠246/i.test(u) || !/Вердикт Создателя/.test(u)));
  assert.ok(pupilUsers.every((u) => !/Вердикт Создателя/.test(u)));
  assert.ok(pupilUsers.every((u) => !/SECRET_RUBRIC/.test(u)));

  const audits = api.sql(
    "SELECT action FROM admin_audit WHERE admin_id = ? AND action LIKE 'teach_dispute:%'",
    userId,
  );
  assert.equal(audits.length, 1);
});
