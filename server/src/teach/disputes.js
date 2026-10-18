// Buddy-018 step 6: Creator disagreement journal. Open ≠ confirmed teaching.
import { HttpError } from '../http.js';
import { chatJson } from '../bi/openai.js';
import { getFragmentSpec } from './fragmentSpecs.js';

const MAX_TEXT = 4_000;
const MAX_CONTEXT = 2_000;
const PROMPT_LIMIT = 20;
const RESOLVED = new Set([
  'resolved_bi_error',
  'resolved_examiner_error',
  'resolved_other',
]);

function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function mapDispute(r) {
  return {
    id: r.id,
    fragmentId: r.fragment_id,
    taskId: r.task_id,
    taskPrompt: r.task_prompt,
    pupilAnswer: r.pupil_answer,
    examinerNote: r.examiner_note,
    creatorRemark: r.creator_remark,
    sourceRef: r.source_ref,
    status: r.status,
    resolutionNote: r.resolution_note,
    teachingId: r.teaching_id || null,
    adminId: r.admin_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at || null,
  };
}

function mapMessage(r) {
  return {
    id: r.id,
    disputeId: r.dispute_id,
    role: r.role,
    kind: r.kind,
    body: r.body,
    createdAt: r.created_at,
  };
}

async function insertMessage(env, disputeId, role, kind, body, createdAt) {
  const id = crypto.randomUUID();
  const text = clip(body, MAX_TEXT);
  if (!text) throw new HttpError(400, 'teach_dispute_empty', 'Пустое сообщение.');
  await env.DB.prepare(
    `INSERT INTO teach_dispute_messages (id, dispute_id, role, kind, body, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).bind(id, disputeId, role, kind, text, createdAt).run();
  return { id, disputeId, role, kind, body: text, createdAt };
}

/**
 * Immediate open dispute from Creator remark («Не согласен» / manual entry).
 */
export async function createTeachDispute(env, input) {
  const spec = getFragmentSpec(input.fragmentId);
  const creatorRemark = clip(input.creatorRemark ?? input.creatorRuling, MAX_TEXT);
  if (creatorRemark.length < 12) {
    throw new HttpError(
      400,
      'teach_dispute_short',
      'Нужно содержательное замечание Создателя (открытый вопрос, не обязательно окончательный ответ).',
    );
  }
  const adminId = String(input.adminId || '');
  if (!adminId) throw new HttpError(401, 'unauthorized', 'Нужен администратор.');

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    fragmentId: spec.fragmentId,
    taskId: clip(input.taskId, 64),
    taskPrompt: clip(input.taskPrompt, MAX_CONTEXT),
    pupilAnswer: clip(input.pupilAnswer, MAX_CONTEXT),
    examinerNote: clip(input.examinerNote, MAX_CONTEXT),
    creatorRemark,
    sourceRef: clip(input.sourceRef, 500),
    status: 'open',
    resolutionNote: '',
    teachingId: null,
    adminId,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
  };

  await env.DB.prepare(
    `INSERT INTO teach_disputes (
      id, fragment_id, task_id, task_prompt, pupil_answer, examiner_note,
      creator_remark, source_ref, status, resolution_note, teaching_id,
      admin_id, created_at, updated_at, resolved_at
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'open','',NULL,?9,?10,?10,NULL)`,
  ).bind(
    row.id,
    row.fragmentId,
    row.taskId,
    row.taskPrompt,
    row.pupilAnswer,
    row.examinerNote,
    row.creatorRemark,
    row.sourceRef,
    row.adminId,
    row.createdAt,
  ).run();

  // Keep step-5 table in sync for older clients.
  await env.DB.prepare(
    `INSERT INTO teach_rulings
      (id, fragment_id, task_id, task_prompt, pupil_answer, examiner_note, creator_ruling, source_ref, admin_id, created_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  ).bind(
    row.id,
    row.fragmentId,
    row.taskId,
    row.taskPrompt,
    row.pupilAnswer,
    row.examinerNote,
    row.creatorRemark,
    row.sourceRef,
    row.adminId,
    row.createdAt,
  ).run();

  await insertMessage(env, id, 'creator', 'remark', creatorRemark, now);
  return row;
}

export async function listTeachDisputes(env, { fragmentId, status, limit = 50 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 100);
  let sql = 'SELECT * FROM teach_disputes WHERE 1=1';
  const binds = [];
  if (fragmentId) {
    const spec = getFragmentSpec(fragmentId);
    binds.push(spec.fragmentId);
    sql += ` AND fragment_id = ?${binds.length}`;
  }
  if (status) {
    binds.push(String(status));
    sql += ` AND status = ?${binds.length}`;
  }
  binds.push(capped);
  sql += ` ORDER BY updated_at DESC LIMIT ?${binds.length}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return (results || []).map(mapDispute);
}

export async function getTeachDispute(env, disputeId) {
  const id = String(disputeId || '').trim();
  if (!id) throw new HttpError(400, 'teach_dispute_id', 'Нужен id разногласия.');
  const row = await env.DB.prepare('SELECT * FROM teach_disputes WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'teach_dispute_not_found', 'Разногласие не найдено.');
  const { results } = await env.DB.prepare(
    'SELECT * FROM teach_dispute_messages WHERE dispute_id = ?1 ORDER BY created_at ASC',
  ).bind(id).all();
  return { dispute: mapDispute(row), messages: (results || []).map(mapMessage) };
}

export async function addDisputeCreatorMessage(env, disputeId, { body, kind = 'reply' } = {}) {
  const { dispute } = await getTeachDispute(env, disputeId);
  if (dispute.status !== 'open') {
    throw new HttpError(409, 'teach_dispute_closed', 'Разногласие уже закрыто.');
  }
  const allowed = kind === 'revised_answer' ? 'revised_answer' : 'reply';
  const now = new Date().toISOString();
  const msg = await insertMessage(env, dispute.id, 'creator', allowed, body, now);
  await env.DB.prepare('UPDATE teach_disputes SET updated_at = ?1 WHERE id = ?2')
    .bind(now, dispute.id).run();
  return msg;
}

/** One Bi reply in dispute thread (not ordinary A–Bi chat). Append-only. */
export async function discussDisputeWithBi(env, disputeId, { creatorMessage } = {}) {
  const packed = await getTeachDispute(env, disputeId);
  const dispute = packed.dispute;
  if (dispute.status !== 'open') {
    throw new HttpError(409, 'teach_dispute_closed', 'Разногласие уже закрыто.');
  }
  const now = new Date().toISOString();
  let creatorMsg = null;
  const text = clip(creatorMessage, MAX_TEXT);
  if (text) {
    creatorMsg = await insertMessage(env, dispute.id, 'creator', 'reply', text, now);
  }

  const history = [
    ...packed.messages.map((m) => `${m.role}/${m.kind}: ${m.body}`),
    ...(creatorMsg ? [`creator/reply: ${creatorMsg.body}`] : []),
  ].join('\n\n');

  const system = `Вы — Ученик Би в разборе учебного разногласия (не обычный чат с А).
Фрагмент ${dispute.fragmentId}. Разногласие ОТКРЫТО: замечание Создателя — открытый вопрос, не обязательно окончательный эталон.
Не объявляйте окончательное усвоение. Не утверждайте запись в постоянную память.
Если видите свою ошибку — признайте и предложите исправленное решение в revised_answer.
Ответьте ТОЛЬКО JSON: {"reply":"текст Создателю","revised_answer":"исправленное решение или пустая строка"}.`;

  const user = [
    `Задача (${dispute.taskId || '—'}):`,
    dispute.taskPrompt || '—',
    '',
    'Первоначальный ответ Би:',
    dispute.pupilAnswer || '—',
    '',
    'Оценка Экзаменатора:',
    dispute.examinerNote || '—',
    '',
    'Замечание Создателя (исходное):',
    dispute.creatorRemark,
    '',
    'История обсуждения:',
    history || '(только исходное замечание)',
  ].join('\n');

  const { json, usage } = await chatJson(env, {
    sessionId: `teach-dispute-${dispute.id}`,
    speaker: 'teach',
    system,
    user,
    maxOutputTokens: 1_200,
  });

  const replyBody = clip(json?.reply || json?.answer || '', MAX_TEXT)
    || 'Би не сформулировал ответ.';
  const revised = clip(json?.revised_answer || '', MAX_TEXT);
  const biNow = new Date().toISOString();
  const biMsg = await insertMessage(env, dispute.id, 'bi', 'reply', replyBody, biNow);
  let revisedMsg = null;
  if (revised) {
    revisedMsg = await insertMessage(env, dispute.id, 'bi', 'revised_answer', revised, biNow);
  }
  await env.DB.prepare('UPDATE teach_disputes SET updated_at = ?1 WHERE id = ?2')
    .bind(biNow, dispute.id).run();

  return {
    creatorMessage: creatorMsg,
    biMessage: biMsg,
    revisedAnswer: revisedMsg,
    usage: usage || null,
  };
}

/**
 * Creator closes dispute → confirmed bi_teachings (existing memory architecture).
 */
export async function resolveTeachDispute(env, disputeId, {
  status,
  resolutionNote,
  formulation,
  adminId,
} = {}) {
  const packed = await getTeachDispute(env, disputeId);
  const dispute = packed.dispute;
  if (dispute.status !== 'open') {
    throw new HttpError(409, 'teach_dispute_closed', 'Разногласие уже закрыто.');
  }
  if (!RESOLVED.has(status)) {
    throw new HttpError(
      400,
      'teach_dispute_status',
      'Статус: resolved_bi_error | resolved_examiner_error | resolved_other.',
    );
  }
  const note = clip(resolutionNote, MAX_TEXT);
  const conclusion = clip(formulation || resolutionNote || dispute.creatorRemark, MAX_TEXT);
  if (conclusion.length < 12) {
    throw new HttpError(400, 'teach_dispute_formulation', 'Нужен подтверждённый вывод (formulation) для записи в учения.');
  }

  const userId = String(adminId || dispute.adminId);
  const teachingId = crypto.randomUUID();
  const now = new Date().toISOString();
  const title = `Разногласие ${dispute.fragmentId}${dispute.taskId ? `/${dispute.taskId}` : ''}`;
  const examples = JSON.stringify([
    {
      disputeId: dispute.id,
      fragmentId: dispute.fragmentId,
      taskId: dispute.taskId,
      taskPrompt: dispute.taskPrompt,
      status,
      messageCount: packed.messages.length,
    },
  ]);
  const constraints = [
    `Источник: teach_dispute:${dispute.id}`,
    `Статус разрешения: ${status}`,
    dispute.sourceRef ? `Опора: ${dispute.sourceRef}` : '',
    'Открытые разногласия не являются утверждённым знанием; эта запись создана только после подтверждения Создателя.',
  ].filter(Boolean).join('\n');

  await env.DB.prepare(
    `INSERT INTO bi_teachings (
      id, user_id, title, formulation, examples_json, constraints_text, domain,
      status, confirmed_at, created_at, updated_at
    ) VALUES (?1,?2,?3,?4,?5,?6,?7,'confirmed',?8,?8,?8)`,
  ).bind(
    teachingId,
    userId,
    title,
    conclusion,
    examples,
    constraints,
    `teach:${dispute.fragmentId}`,
    now,
  ).run();

  await env.DB.prepare(
    `UPDATE teach_disputes
     SET status = ?1, resolution_note = ?2, teaching_id = ?3, updated_at = ?4, resolved_at = ?4
     WHERE id = ?5`,
  ).bind(status, note, teachingId, now, dispute.id).run();

  await insertMessage(
    env,
    dispute.id,
    'system',
    'resolution',
    `Закрыто Создателем как ${status}. teaching_id=${teachingId}. ${note || conclusion}`,
    now,
  );

  const updated = await getTeachDispute(env, dispute.id);
  return { ...updated, teachingId };
}

/** Examiner prompt block: open = questions; resolved = confirmed conclusions. Never for Pupil. */
export function formatDisputesForExaminer(disputes) {
  const list = Array.isArray(disputes) ? disputes.slice(0, PROMPT_LIMIT) : [];
  if (!list.length) return '';
  const open = list.filter((d) => d.status === 'open');
  const resolved = list.filter((d) => d.status !== 'open');
  const lines = [];
  if (open.length) {
    lines.push(
      'Открытые разногласия Создателя (НЕ утверждённое знание; учитывайте как нерешённые вопросы при задачах/оценке):',
    );
    open.forEach((d, i) => {
      lines.push(`--- Открыто ${i + 1} (${d.createdAt || ''}) id=${d.id} ---`);
      if (d.taskId) lines.push(`task_id: ${d.taskId}`);
      if (d.taskPrompt) lines.push(`Задача: ${d.taskPrompt}`);
      if (d.pupilAnswer) lines.push(`Ответ Би: ${d.pupilAnswer}`);
      if (d.examinerNote) lines.push(`Оценка Экзаменатора: ${d.examinerNote}`);
      lines.push(`Замечание Создателя: ${d.creatorRemark}`);
    });
  }
  if (resolved.length) {
    lines.push(
      'Разрешённые разногласия (подтверждённый вывод Создателя; приоритет при конфликте с вашей прошлой оценкой):',
    );
    resolved.forEach((d, i) => {
      lines.push(`--- Разрешено ${i + 1} (${d.resolvedAt || d.updatedAt || ''}) ${d.status} ---`);
      if (d.taskId) lines.push(`task_id: ${d.taskId}`);
      lines.push(`Вывод: ${d.resolutionNote || d.creatorRemark}`);
      if (d.teachingId) lines.push(`teaching_id: ${d.teachingId}`);
    });
  }
  return lines.join('\n');
}

/** @deprecated step-5 name */
export async function createTeachRuling(env, input) {
  return createTeachDispute(env, input);
}

/** @deprecated step-5 list shape for Examiner injection */
export async function listTeachRulings(env, fragmentId, opts = {}) {
  const rows = await listTeachDisputes(env, { fragmentId, ...opts });
  return rows.map((d) => ({
    id: d.id,
    fragmentId: d.fragmentId,
    taskId: d.taskId,
    taskPrompt: d.taskPrompt,
    pupilAnswer: d.pupilAnswer,
    examinerNote: d.examinerNote,
    creatorRuling: d.creatorRemark,
    sourceRef: d.sourceRef,
    adminId: d.adminId,
    createdAt: d.createdAt,
    status: d.status,
    resolutionNote: d.resolutionNote,
    teachingId: d.teachingId,
  }));
}

export function formatRulingsForExaminer(rulings) {
  return formatDisputesForExaminer(
    (rulings || []).map((r) => ({
      ...r,
      creatorRemark: r.creatorRemark || r.creatorRuling,
      status: r.status || 'open',
    })),
  );
}

export const __test = {
  clip,
  formatDisputesForExaminer,
  formatRulingsForExaminer,
  RESOLVED,
  PROMPT_LIMIT,
  MAX_TEXT,
};
