import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { NOTION_API } from '../src/notion/readPage.js';
import { getFragmentSpec, DEFAULT_CHAIN_IDS } from '../src/teach/fragmentSpecs.js';
import { getApprovedChainIds } from '../src/teach/chain.js';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  return { token: login.data.session.token, userId: login.data.user.id };
}

function installCycleMocks(api) {
  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    const href = String(url);
    if (href.startsWith(NOTION_API)) {
      if (href.includes('/v1/pages/')) {
        const m = href.match(/\/v1\/pages\/([^?/]+)/);
        const pageId = m ? decodeURIComponent(m[1]) : 'unknown';
        return Response.json({
          object: 'page',
          id: pageId,
          properties: { title: { type: 'title', title: [{ plain_text: 'page' }] } },
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
            paragraph: { rich_text: [{ plain_text: 'Учебный материал для теста цепочки.' }] },
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
      let content = { ok: true };
      if (/составляете проверочные задачи ДО/i.test(system)) {
        content = {
          tasks: [1, 2, 3].map((n) => ({
            id: `t${n}`,
            prompt: `Новая задача цепочки №${n} на применение метода вне текста`,
            novelty: { is_new: true, reason: 'Содержательно новая ситуация вне примеров автора из абзаца.' },
            rubric: {
              letter: 'буква',
              spirit: 'дух',
              model_answer_hint: `SECRET_${n}`,
              source_ref: 'якорь',
            },
          })),
        };
      } else if (/основные принципы/i.test(system)) {
        content = { principles: ['p1'], summary: 's' };
      } else if (/Решите задачи самостоятельно/i.test(system)) {
        content = {
          answers: [
            { task_id: 't1', answer: 'a' },
            { task_id: 't2', answer: 'b' },
            { task_id: 't3', answer: 'c' },
          ],
        };
      } else if (/Оцените решения Ученика/i.test(system) || /повторном испытании/i.test(system)) {
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
}

test('approved chain is F01–F15', () => {
  assert.deepEqual(getApprovedChainIds(), [...DEFAULT_CHAIN_IDS]);
  assert.equal(getApprovedChainIds().length, 15);
  assert.equal(getFragmentSpec('F15').pageId, getFragmentSpec('F15').pageId);
});

test('GET /admin/teach/fragments lists chain', async () => {
  const api = await createEnv();
  const { token } = await asAdmin(api);
  const res = await api.call('GET', '/admin/teach/fragments', { token });
  assert.equal(res.status, 200);
  assert.equal(res.data.chain.length, 15);
  assert.equal(res.data.fragments.length, 15);
});

test('chain start + continue: два шага, стоп на open dispute', async () => {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';
  installCycleMocks(api);
  const { token } = await asAdmin(api);

  const started = await api.call('POST', '/admin/teach/chain/start', {
    token,
    body: { fragmentIds: ['F01', 'F02'] },
  });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.run.status, 'running');
  assert.equal(started.data.run.nextFragmentId, 'F01');

  const step1 = await api.call('POST', '/admin/teach/chain/continue', {
    token,
    body: { runId: started.data.run.id },
  });
  assert.equal(step1.status, 200, JSON.stringify(step1.data));
  assert.equal(step1.data.report.fragmentId, 'F01');
  assert.equal(step1.data.run.cursorIndex, 1);
  assert.equal(step1.data.run.nextFragmentId, 'F02');
  assert.equal(step1.data.stopped, false);

  // Open dispute on F02 → next continue pauses without running F02 cycle
  const dispute = await api.call('POST', '/admin/teach/dispute', {
    token,
    body: {
      fragmentId: 'F02',
      taskId: 't1',
      creatorRemark: 'Открытый вопрос Создателя по F02 для паузы цепочки.',
    },
  });
  assert.equal(dispute.status, 201);

  const step2 = await api.call('POST', '/admin/teach/chain/continue', {
    token,
    body: { runId: started.data.run.id },
  });
  assert.equal(step2.status, 200, JSON.stringify(step2.data));
  assert.equal(step2.data.stopped, true);
  assert.equal(step2.data.run.status, 'paused');
  assert.match(step2.data.run.pauseReason, /Открытое разногласие|F02/);
  assert.equal(step2.data.report, null);
});

test('chain completes short list', async () => {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  api.env.NOTION_TOKEN = 'test-notion-token-placeholder';
  installCycleMocks(api);
  const { token } = await asAdmin(api);

  const started = await api.call('POST', '/admin/teach/chain/start', {
    token,
    body: { fragmentIds: ['F01'] },
  });
  const step = await api.call('POST', '/admin/teach/chain/continue', {
    token,
    body: { runId: started.data.run.id },
  });
  assert.equal(step.data.run.status, 'completed');
  assert.equal(step.data.stopped, false);
  assert.equal(step.data.run.results.length, 1);
});
