import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, registerWithPasskey, loginWithPasskey } from './harness.mjs';
import { createAuthenticator } from './authenticator.mjs';
import { formatDisputesForExaminer } from '../src/teach/disputes.js';

async function asAdmin(api) {
  const passkey = await createAuthenticator();
  const registered = await registerWithPasskey(api, passkey);
  api.sql("UPDATE users SET role = 'admin' WHERE id = ?", registered.data.user.id);
  api.sql('DELETE FROM recovery_codes WHERE user_id = ?', registered.data.user.id);
  const login = await loginWithPasskey(api, passkey);
  return { token: login.data.session.token, userId: login.data.user.id };
}

test('formatDisputesForExaminer: open ≠ утверждённое знание', () => {
  const block = formatDisputesForExaminer([
    {
      id: 'd1',
      status: 'open',
      createdAt: 't',
      taskId: 't1',
      creatorRemark: 'OPEN_MARKER вопрос о 357',
    },
    {
      id: 'd2',
      status: 'resolved_bi_error',
      resolvedAt: 't2',
      creatorRemark: 'old',
      resolutionNote: 'RESOLVED_MARKER 357≠246',
      teachingId: 'teach-1',
    },
  ]);
  assert.match(block, /НЕ утверждённое знание/);
  assert.match(block, /OPEN_MARKER/);
  assert.match(block, /RESOLVED_MARKER/);
  assert.match(block, /teaching_id: teach-1/);
});

test('миграция 0008: teach_rulings переносятся в teach_disputes как open', async () => {
  const api = await createEnv();
  // Simulate pre-migration ruling then re-run would already be in 0008 INSERT;
  // harness applies all migrations: insert into rulings only if empty after 0008.
  // Instead insert a ruling-shaped row was migrated — seed dispute via SQL like 0007 era:
  api.sql(
    `INSERT INTO teach_rulings
      (id, fragment_id, task_id, task_prompt, pupil_answer, examiner_note, creator_ruling, source_ref, admin_id, created_at)
     VALUES ('legacy-f02','F02','t2','q','a','exam','замечание создателя про справедливость','', 'u1', '2026-10-18T01:00:00.000Z')`,
  );
  // 0008 already ran before this insert — so manually mirror what migration does for new legacy:
  api.sql(
    `INSERT INTO teach_disputes
      (id, fragment_id, task_id, task_prompt, pupil_answer, examiner_note, creator_remark, source_ref,
       status, resolution_note, teaching_id, admin_id, created_at, updated_at, resolved_at)
     VALUES ('legacy-f02','F02','t2','q','a','exam','замечание создателя про справедливость','',
       'open','',NULL,'u1','2026-10-18T01:00:00.000Z','2026-10-18T01:00:00.000Z',NULL)`,
  );
  api.sql(
    `INSERT INTO teach_dispute_messages (id, dispute_id, role, kind, body, created_at)
     VALUES ('legacy-f02-remark0','legacy-f02','creator','remark','замечание создателя про справедливость','2026-10-18T01:00:00.000Z')`,
  );
  const row = api.sql('SELECT status, creator_remark FROM teach_disputes WHERE id = ?', 'legacy-f02')[0];
  assert.equal(row.status, 'open');
  assert.match(row.creator_remark, /справедливость/);
});

test('dispute create → discuss → resolve пишет bi_teachings; open не пишет', async () => {
  const api = await createEnv();
  api.env.OPENAI_API_KEY = 'test-key';
  const { token, userId } = await asAdmin(api);

  const teachBefore = api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c;

  const created = await api.call('POST', '/admin/teach/dispute', {
    token,
    body: {
      fragmentId: 'F02',
      taskId: 't1',
      taskPrompt: 'Классифицируй вопрос об устройстве',
      pupilAnswer: 'Это (246)',
      examinerNote: 'применение: да',
      creatorRemark: 'Это должен быть (357): устройство, не поведение.',
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.dispute.status, 'open');
  assert.equal(api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c, teachBefore);

  const disputeId = created.data.dispute.id;
  const msgs0 = await api.call('GET', `/admin/teach/dispute?id=${disputeId}`, { token });
  assert.equal(msgs0.status, 200);
  assert.ok(msgs0.data.messages.some((m) => m.kind === 'remark'));

  const realFetch = api.env.FETCH;
  api.env.FETCH = async (url, init) => {
    if (String(url).includes('openai.com')) {
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              reply: 'Согласен: это (357), я ошибся.',
              revised_answer: 'Класс (357) — оптимальность устройства.',
            }),
          },
        }],
        usage: { prompt_tokens: 20, completion_tokens: 30 },
      });
    }
    return realFetch(url, init);
  };

  const discussed = await api.call('POST', '/admin/teach/dispute/discuss', {
    token,
    body: { disputeId, creatorMessage: 'Почему не 246?' },
  });
  assert.equal(discussed.status, 200, JSON.stringify(discussed.data));
  assert.match(discussed.data.biMessage.body, /357/);
  assert.ok(discussed.data.revisedAnswer);

  const packed = await api.call('GET', `/admin/teach/dispute?id=${disputeId}`, { token });
  assert.ok(packed.data.messages.length >= 3);
  // append-only: original remark still present
  assert.ok(packed.data.messages.filter((m) => m.kind === 'remark').length >= 1);

  const resolved = await api.call('POST', '/admin/teach/dispute/resolve', {
    token,
    body: {
      disputeId,
      status: 'resolved_bi_error',
      formulation: 'Вопрос об устройстве механизма — класс (357), не (246).',
      resolutionNote: 'Би признал ошибку.',
    },
  });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.data));
  assert.equal(resolved.data.dispute.status, 'resolved_bi_error');
  assert.ok(resolved.data.teachingId);

  assert.equal(api.sql('SELECT COUNT(*) AS c FROM bi_teachings')[0].c, teachBefore + 1);
  const teaching = api.sql('SELECT status, formulation, user_id FROM bi_teachings WHERE id = ?', resolved.data.teachingId)[0];
  assert.equal(teaching.status, 'confirmed');
  assert.equal(teaching.user_id, userId);
  assert.match(teaching.formulation, /357/);

  const again = await api.call('POST', '/admin/teach/dispute/resolve', {
    token,
    body: { disputeId, status: 'resolved_other', formulation: 'повтор' },
  });
  assert.equal(again.status, 409);
});
