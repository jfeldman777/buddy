// Buddy-018: Creator rulings after Examiner disagreement. Applied on next teach run for the fragment.
import { HttpError } from '../http.js';
import { getFragmentSpec } from './fragmentSpecs.js';

const MAX_RULING = 4_000;
const MAX_CONTEXT = 2_000;
const PROMPT_LIMIT = 20;

function clip(text, max) {
  const s = String(text || '').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * @param {object} env
 * @param {{
 *   fragmentId: string,
 *   taskId?: string,
 *   taskPrompt?: string,
 *   pupilAnswer?: string,
 *   examinerNote?: string,
 *   creatorRuling: string,
 *   sourceRef?: string,
 *   adminId: string,
 * }} input
 */
export async function createTeachRuling(env, input) {
  const spec = getFragmentSpec(input.fragmentId);
  const creatorRuling = clip(input.creatorRuling, MAX_RULING);
  if (creatorRuling.length < 12) {
    throw new HttpError(400, 'teach_ruling_short', 'Нужно содержательное замечание Создателя (хотя бы коротко: в чём ошибка и как правильно).');
  }
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    fragmentId: spec.fragmentId,
    taskId: clip(input.taskId, 64),
    taskPrompt: clip(input.taskPrompt, MAX_CONTEXT),
    pupilAnswer: clip(input.pupilAnswer, MAX_CONTEXT),
    examinerNote: clip(input.examinerNote, MAX_CONTEXT),
    creatorRuling,
    sourceRef: clip(input.sourceRef, 500),
    adminId: String(input.adminId || ''),
    createdAt,
  };
  if (!row.adminId) throw new HttpError(401, 'unauthorized', 'Нужен администратор.');

  await env.DB.prepare(
    `INSERT INTO teach_rulings
      (id, fragment_id, task_id, task_prompt, pupil_answer, examiner_note, creator_ruling, source_ref, admin_id, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  ).bind(
    row.id,
    row.fragmentId,
    row.taskId,
    row.taskPrompt,
    row.pupilAnswer,
    row.examinerNote,
    row.creatorRuling,
    row.sourceRef,
    row.adminId,
    row.createdAt,
  ).run();

  return row;
}

/** @returns {Promise<object[]>} newest first */
export async function listTeachRulings(env, fragmentId, { limit = 50 } = {}) {
  const spec = getFragmentSpec(fragmentId);
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { results } = await env.DB.prepare(
    `SELECT id, fragment_id, task_id, task_prompt, pupil_answer, examiner_note,
            creator_ruling, source_ref, admin_id, created_at
     FROM teach_rulings
     WHERE fragment_id = ?1
     ORDER BY created_at DESC
     LIMIT ?2`,
  ).bind(spec.fragmentId, capped).all();

  return (results || []).map((r) => ({
    id: r.id,
    fragmentId: r.fragment_id,
    taskId: r.task_id,
    taskPrompt: r.task_prompt,
    pupilAnswer: r.pupil_answer,
    examinerNote: r.examiner_note,
    creatorRuling: r.creator_ruling,
    sourceRef: r.source_ref,
    adminId: r.admin_id,
    createdAt: r.created_at,
  }));
}

/** Compact block for Examiner prompts only (never for Pupil). */
export function formatRulingsForExaminer(rulings) {
  const list = Array.isArray(rulings) ? rulings.slice(0, PROMPT_LIMIT) : [];
  if (!list.length) return '';
  const lines = [
    'Вердикты Создателя по прошлым циклам этого фрагмента (обязательны; при конфликте с вашей прошлой оценкой — приоритет у Создателя):',
  ];
  list.forEach((r, i) => {
    lines.push(`--- Вердикт ${i + 1} (${r.createdAt || ''}) ---`);
    if (r.taskId) lines.push(`task_id: ${r.taskId}`);
    if (r.taskPrompt) lines.push(`Задача тогда: ${r.taskPrompt}`);
    if (r.pupilAnswer) lines.push(`Ответ Ученика тогда: ${r.pupilAnswer}`);
    if (r.examinerNote) lines.push(`Оценка Экзаменатора тогда: ${r.examinerNote}`);
    lines.push(`Вердикт Создателя: ${r.creatorRuling}`);
    if (r.sourceRef) lines.push(`Опора Создателя: ${r.sourceRef}`);
  });
  return lines.join('\n');
}

export const __test = { clip, formatRulingsForExaminer, PROMPT_LIMIT, MAX_RULING };
