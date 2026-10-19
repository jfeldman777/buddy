import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { documentsToPages } from '../src/teach/corpusDocuments.js';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  return { token: login.data.session.token, userId: login.data.user.id };
}

test('documentsToPages: нумерация файлов', () => {
  const pages = documentsToPages([
    { id: 'a', title: 'A', filename: 'a.docx', text: 'one', kind: 'docx' },
    { id: 'b', title: 'B', filename: 'b.pdf', text: 'two', kind: 'pdf' },
  ]);
  assert.equal(pages.length, 2);
  assert.equal(pages[0].n, 1);
  assert.equal(pages[1].source, 'file');
});

test('corpus upload + file session turn without Notion ingest', async () => {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    if (String(url).includes('openai.com')) {
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              action: 'reply',
              utterance: 'Четыре грани: …',
              kind: 'answer',
            }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 8 },
      });
    }
    return realFetch(url, init);
  };

  const { token } = await asAdmin(api);

  const emptyStart = await api.call('POST', '/admin/teach/session/start', {
    token,
    body: { source: 'files' },
  });
  assert.equal(emptyStart.status, 400);
  assert.equal(emptyStart.data.error, 'teach_corpus_empty_set');

  const add1 = await api.call('POST', '/admin/teach/corpus/documents', {
    token,
    body: {
      filename: 'facets.docx',
      title: 'Грани',
      kind: 'docx',
      text: 'Мышление, поведение, со-знание, взаимодействие.',
    },
  });
  assert.equal(add1.status, 201, JSON.stringify(add1.data));

  const add2 = await api.call('POST', '/admin/teach/corpus/documents', {
    token,
    body: {
      filename: 'music.pdf',
      kind: 'pdf',
      text: 'Уровни 1–8 на музыке как иллюстрация шкалы.',
    },
  });
  assert.equal(add2.status, 201);

  const listed = await api.call('GET', '/admin/teach/corpus/documents', { token });
  assert.equal(listed.data.count, 2);

  const started = await api.call('POST', '/admin/teach/session/start', {
    token,
    body: { source: 'files' },
  });
  assert.equal(started.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.session.corpusKind, 'files');
  assert.equal(started.data.session.status, 'ready');
  assert.equal(started.data.session.progress.total, 2);

  const turn = await api.call('POST', '/admin/teach/session/turn', {
    token,
    body: {
      sessionId: started.data.session.id,
      text: 'Перечисли четыре грани из корпуса.',
    },
  });
  assert.equal(turn.status, 200, JSON.stringify(turn.data));
  assert.equal(turn.data.reply.kind, 'answer');
  assert.match(turn.data.reply.utterance, /грани/i);
});
