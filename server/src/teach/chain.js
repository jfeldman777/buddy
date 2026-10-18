// Buddy-018 step 7A: run approved fragment chain one step at a time (Worker-safe).
import { HttpError } from '../http.js';
import { DEFAULT_CHAIN_IDS, getFragmentSpec } from './fragmentSpecs.js';
import { runTeachCycle } from './fragmentCycle.js';
import { listTeachDisputes } from './disputes.js';

/** Auto-retries of the same fragment on Examiner/source tech errors (no Creator, no chain restart). */
export const TECH_AUTO_RETRIES = 3;

function nowIso() {
  return new Date().toISOString();
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function mapRun(row) {
  return {
    id: row.id,
    programVersion: row.program_version,
    status: row.status,
    pauseReason: row.pause_reason || '',
    cursorIndex: Number(row.cursor_index) || 0,
    fragmentIds: parseJson(row.fragment_ids_json, []),
    results: parseJson(row.results_json, []),
    adminId: row.admin_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nextFragmentId: null,
  };
}

function withNext(run) {
  const ids = run.fragmentIds || [];
  const next = run.status === 'running' && run.cursorIndex < ids.length
    ? ids[run.cursorIndex]
    : null;
  return { ...run, nextFragmentId: next };
}

/** Trailing tech failures for fragment since last pass/resume marker. */
function countOpenTechAttempts(run, fragmentId) {
  let n = 0;
  for (let i = (run.results || []).length - 1; i >= 0; i -= 1) {
    const r = run.results[i];
    if (r.fragmentId !== fragmentId) break;
    if (r.status === 'error' && (r.stopKind === 'technical' || !r.stopKind)) n += 1;
    else break;
  }
  return n;
}

function lastResult(run) {
  const results = run.results || [];
  return results.length ? results[results.length - 1] : null;
}

/** Tech pause/fail: Creator not needed; same cursor can resume. */
export function isTechnicalStop(run) {
  if (!run) return false;
  if (run.status === 'failed') return true;
  if (run.status !== 'paused') return false;
  const last = lastResult(run);
  if (last?.stopKind === 'technical') return true;
  return /^ТЕХСБОЙ/i.test(run.pauseReason || '');
}

function isCreatorGateStop(run) {
  if (!run || run.status !== 'paused') return false;
  if (isTechnicalStop(run)) return false;
  const last = lastResult(run);
  if (last?.stopKind === 'open_dispute' || last?.stopKind === 'pupil_fail') return true;
  return /разноглас|ПРОВАЛ УЧЕНИЯ/i.test(run.pauseReason || '');
}

async function loadRun(env, runId) {
  const id = String(runId || '').trim();
  if (!id) throw new HttpError(400, 'teach_chain_id', 'Нужен id цепочки.');
  const row = await env.DB.prepare('SELECT * FROM teach_chain_runs WHERE id = ?1').bind(id).first();
  if (!row) throw new HttpError(404, 'teach_chain_not_found', 'Прогон цепочки не найден.');
  return withNext(mapRun(row));
}

async function saveRun(env, run) {
  await env.DB.prepare(
    `UPDATE teach_chain_runs
     SET status = ?1, pause_reason = ?2, cursor_index = ?3, results_json = ?4, updated_at = ?5
     WHERE id = ?6`,
  ).bind(
    run.status,
    run.pauseReason || '',
    run.cursorIndex,
    JSON.stringify(run.results || []),
    run.updatedAt,
    run.id,
  ).run();
  return withNext(run);
}

/** Default Creator-approved chain for current program (files/Methodist reorder — later phases). */
export function getApprovedChainIds() {
  return [...DEFAULT_CHAIN_IDS];
}

/**
 * Latest incomplete run that can resume from cursor without re-running passed prefix.
 * Only technical stops (not pupil fail / open dispute).
 */
async function findResumableTechRun(env, adminId) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM teach_chain_runs
     WHERE admin_id = ?1 AND status IN ('failed', 'paused', 'running')
     ORDER BY updated_at DESC LIMIT 10`,
  ).bind(String(adminId || '')).all();

  for (const row of results || []) {
    const run = withNext(mapRun(row));
    if (run.cursorIndex >= (run.fragmentIds || []).length) continue;
    if (run.status === 'running' && run.nextFragmentId) {
      // Abandoned in-flight: continue same cursor (prefix already in results).
      return run;
    }
    if (isTechnicalStop(run) && !isCreatorGateStop(run)) return run;
  }
  return null;
}

function markTechResume(run, fragmentId) {
  run.results.push({
    fragmentId,
    status: 'tech_resume',
    stopKind: 'technical_resume',
    at: nowIso(),
  });
}

/**
 * Start a new chain, or economically resume the last tech-stopped run
 * (prefix F01… already passed stays attached; cursor stays on first unfinished).
 */
export async function startTeachChain(env, { adminId, fragmentIds, forceNew = false } = {}) {
  const admin = String(adminId || '');
  if (!admin) throw new HttpError(401, 'unauthorized', 'Нужен администратор.');

  const customIds = Array.isArray(fragmentIds) && fragmentIds.length
    ? fragmentIds.map((x) => getFragmentSpec(x).fragmentId)
    : null;

  if (!forceNew && !customIds) {
    const existing = await findResumableTechRun(env, admin);
    if (existing) {
      const frag = existing.fragmentIds[existing.cursorIndex];
      if (isTechnicalStop(existing) || existing.status !== 'running') {
        markTechResume(existing, frag);
      }
      existing.status = 'running';
      existing.pauseReason = '';
      existing.updatedAt = nowIso();
      await saveRun(env, existing);
      return {
        ...withNext(existing),
        resumed: true,
        resumeFrom: frag,
        carriedPrefix: (existing.results || []).filter((r) => r.status === 'experimental_preliminary_pass')
          .map((r) => r.fragmentId),
      };
    }
  }

  const ids = customIds || getApprovedChainIds();
  for (const id of ids) getFragmentSpec(id);

  const run = {
    id: crypto.randomUUID(),
    programVersion: 'bi-program-v002',
    status: 'running',
    pauseReason: '',
    cursorIndex: 0,
    fragmentIds: ids,
    results: [],
    adminId: admin,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    resumed: false,
  };

  await env.DB.prepare(
    `INSERT INTO teach_chain_runs
      (id, program_version, status, pause_reason, cursor_index, fragment_ids_json, results_json, admin_id, created_at, updated_at)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?9)`,
  ).bind(
    run.id,
    run.programVersion,
    run.status,
    '',
    0,
    JSON.stringify(run.fragmentIds),
    '[]',
    run.adminId,
    run.createdAt,
  ).run();

  return withNext(run);
}

export async function getTeachChain(env, runId) {
  return loadRun(env, runId);
}

export async function listTeachChains(env, { limit = 20 } = {}) {
  const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const { results } = await env.DB.prepare(
    'SELECT * FROM teach_chain_runs ORDER BY updated_at DESC LIMIT ?1',
  ).bind(capped).all();
  return (results || []).map((r) => withNext(mapRun(r)));
}

/**
 * Run exactly one next fragment.
 * Tech errors: auto-retry same cursor (no Creator). Pupil fail / open dispute: pause for Creator.
 */
export async function continueTeachChain(env, runId, { adminId } = {}) {
  let run = await loadRun(env, runId);

  if (run.status === 'completed') {
    return { run, report: null, stopped: false };
  }

  // Economical resume: tech-stopped run continues from same cursor (prefix kept).
  if (isTechnicalStop(run)) {
    const frag = run.fragmentIds[run.cursorIndex];
    markTechResume(run, frag);
    run.status = 'running';
    run.pauseReason = '';
    run.updatedAt = nowIso();
    await saveRun(env, run);
    run = withNext(run);
  } else if (run.status === 'paused' || run.status === 'failed') {
    throw new HttpError(
      409,
      'teach_chain_paused',
      run.pauseReason || 'Цепочка на паузе. Нужно действие Создателя (разногласие или провал учения), затем новый прогон или продолжение после закрытия журнала.',
    );
  }

  if (run.status !== 'running') {
    throw new HttpError(409, 'teach_chain_bad_status', `Статус цепочки: ${run.status}`);
  }

  const fragmentId = run.fragmentIds[run.cursorIndex];
  if (!fragmentId) {
    run.status = 'completed';
    run.updatedAt = nowIso();
    await saveRun(env, run);
    return { run: withNext(run), report: null, stopped: false };
  }

  // Stop before running if this fragment already has an open Creator dispute.
  const open = await listTeachDisputes(env, { fragmentId, status: 'open', limit: 5 });
  if (open.length) {
    run.status = 'paused';
    run.pauseReason = [
      `ПАУЗА · разногласие · ${fragmentId}`,
      `В журнале ${open.length} открытое(ых) разногласие(й) по этому фрагменту.`,
      'Цепочка не запускала экзамен. Закройте запись в журнале, затем новый прогон.',
    ].join(' ');
    run.updatedAt = nowIso();
    await saveRun(env, run);
    return { run: withNext(run), report: null, stopped: true, stopKind: 'open_dispute' };
  }

  let report;
  try {
    report = await runTeachCycle(env, { fragmentId, adminId: adminId || run.adminId });
  } catch (err) {
    const code = err?.code || 'error';
    const message = err?.message || String(err);
    const attempt = countOpenTechAttempts(run, fragmentId) + 1;
    run.results.push({
      fragmentId,
      status: 'error',
      stopKind: 'technical',
      error: code,
      message,
      attempt,
      at: nowIso(),
    });
    run.updatedAt = nowIso();

    if (attempt < TECH_AUTO_RETRIES) {
      // Stay on same cursor; client/loop continues — no Creator, no chain restart.
      run.status = 'running';
      run.pauseReason = [
        `АВТОПОВТОР · ${fragmentId}`,
        `техсбой ${attempt}/${TECH_AUTO_RETRIES} (${code}): ${message}`,
        'Префикс цепочки сохранён; повторяем только этот блок.',
      ].join(' ');
      await saveRun(env, run);
      return {
        run: withNext(run),
        report: null,
        stopped: false,
        stopKind: 'technical_retry',
        techAttempt: attempt,
        techRetryLimit: TECH_AUTO_RETRIES,
      };
    }

    run.status = 'paused';
    run.pauseReason = [
      `ТЕХСБОЙ · ${fragmentId}`,
      `Автоповторы ${TECH_AUTO_RETRIES}/${TECH_AUTO_RETRIES} исчерпаны (${code}).`,
      message,
      'Создателя звать не нужно. Следующий запуск цепочки продолжит с этого блока; уже пройденный префикс не перепрогоняется.',
    ].join(' ');
    await saveRun(env, run);
    return {
      run: withNext(run),
      report: null,
      stopped: true,
      stopKind: 'technical',
      techAttempt: attempt,
      techRetryLimit: TECH_AUTO_RETRIES,
      error: err,
    };
  }

  run.results.push({
    fragmentId,
    status: report.status,
    experiment: report.experiment,
    creatorDisputesApplied: report.creatorDisputesApplied || 0,
    at: nowIso(),
  });
  run.cursorIndex += 1;
  run.pauseReason = '';
  run.updatedAt = nowIso();

  if (report.status === 'experimental_preliminary_fail') {
    run.status = 'paused';
    run.pauseReason = [
      `ПРОВАЛ УЧЕНИЯ · ${fragmentId}`,
      'Экзаменатор не зачёл фрагмент (буква/дух: меньше 2 успешных задач из 3).',
      'Смотрите отчёт ниже. Если согласны с Экзаменатором — журнал не нужен; повторите фрагмент позже.',
      '«Не согласен» — только если не согласны с оценкой Экзаменатора.',
    ].join(' ');
    run.results[run.results.length - 1].stopKind = 'pupil_fail';
    await saveRun(env, run);
    return { run: withNext(run), report, stopped: true, stopKind: 'pupil_fail' };
  }

  // Fresh open disputes created mid-cycle shouldn't happen (cycle doesn't create them),
  // but stop if Creator had parallel activity.
  const openAfter = await listTeachDisputes(env, { fragmentId, status: 'open', limit: 5 });
  if (openAfter.length) {
    run.status = 'paused';
    run.pauseReason = [
      `ПАУЗА · разногласие · ${fragmentId}`,
      'После цикла в журнале есть открытые разногласия. Закройте их, затем новый прогон.',
    ].join(' ');
    await saveRun(env, run);
    return { run: withNext(run), report, stopped: true, stopKind: 'open_dispute' };
  }

  if (run.cursorIndex >= run.fragmentIds.length) {
    run.status = 'completed';
    run.pauseReason = '';
  }

  await saveRun(env, run);
  return { run: withNext(run), report, stopped: false };
}

export const __test = {
  mapRun,
  withNext,
  getApprovedChainIds,
  countOpenTechAttempts,
  isTechnicalStop,
  TECH_AUTO_RETRIES,
};
