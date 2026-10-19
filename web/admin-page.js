import { registerServiceWorker } from './pwa.js';
import { openStorage } from './storage.js';
import { api } from './api.js';
import { currentUser, signInWithPasskey, signOut } from './account.js';
import { extractTeachFile } from './teachCorpusExtract.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const status = $('admin-status');
const signedOut = $('admin-signed-out');
const panel = $('admin-panel');
const rows = $('admin-users');
const teachStatus = $('admin-teach-status');
const teachResult = $('admin-teach-result');
const teachFragment = $('admin-teach-fragment');
const teachBtn = $('admin-teach-run');
const teachChainBtn = $('admin-teach-chain');
const teachChainStatus = $('admin-teach-chain-status');
const teachSessionStatus = $('admin-teach-session-status');
const teachSessionLog = $('admin-teach-session-log');
const teachSessionCompose = $('admin-teach-session-compose');
const teachSessionInput = $('admin-teach-session-input');
const teachSessionStartBtn = $('admin-teach-session-start');
const teachSessionFilesBtn = $('admin-teach-session-files');
const teachCorpusUploadBtn = $('admin-teach-corpus-upload');
const teachCorpusClearBtn = $('admin-teach-corpus-clear');
const teachCorpusFiles = $('admin-teach-corpus-files');
const teachCorpusList = $('admin-teach-corpus-list');
const teachSessionSendBtn = $('admin-teach-session-send');
const teachSessionCloseBtn = $('admin-teach-session-close');
const disputesList = $('admin-disputes-list');
const disputeDetail = $('admin-dispute-detail');
const disputeManual = $('admin-dispute-manual');

const storage = await openStorage();
let session = null;
let teachRunning = false;
let teachSession = null;
let teachSessionBusy = false;
const disputeStatusRu = {
  open: 'открыто',
  resolved_bi_error: 'закрыто: ошибка Би',
  resolved_examiner_error: 'закрыто: ошибка Экзаменатора',
  resolved_other: 'закрыто: иное',
};

function showStatus(text) {
  status.textContent = text;
  status.hidden = !text;
  if (text) status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function showTeachStatus(text) {
  teachStatus.textContent = text;
  teachStatus.hidden = !text;
}

function showTeachSessionStatus(text) {
  if (!teachSessionStatus) return;
  teachSessionStatus.textContent = text;
  teachSessionStatus.hidden = !text;
}

function renderTeachSessionLog(teach) {
  if (!teachSessionLog) return;
  teachSessionLog.replaceChildren();
  const msgs = teach?.messages || [];
  if (!msgs.length) {
    teachSessionLog.hidden = true;
    return;
  }
  teachSessionLog.hidden = false;
  for (const m of msgs) {
    const who = m.role === 'bi' ? 'Би' : 'Создатель';
    const kind = m.role === 'bi' && m.kind === 'question' ? ' (вопрос)' : '';
    const row = el('div', m.role === 'bi' ? 'admin-teach-msg bi' : 'admin-teach-msg creator');
    row.append(el('strong', '', `${who}${kind}`));
    row.append(document.createTextNode(`: ${m.text}`));
    teachSessionLog.append(row);
  }
  teachSessionLog.scrollTop = teachSessionLog.scrollHeight;
}

function setTeachSessionUi(teach) {
  teachSession = teach || null;
  const ready = teach?.status === 'ready';
  const open = teach && teach.status !== 'closed';
  if (teachSessionCompose) teachSessionCompose.hidden = !ready;
  if (teachSessionCloseBtn) teachSessionCloseBtn.hidden = !open;
  if (teachSessionStartBtn) teachSessionStartBtn.disabled = teachSessionBusy;
  if (teachSessionSendBtn) teachSessionSendBtn.disabled = teachSessionBusy || !ready;
  renderTeachSessionLog(teach);
}

async function refreshCorpusList() {
  if (!session?.token || !teachCorpusList) return;
  try {
    const data = await api.adminTeachCorpusDocuments(session.token);
    const docs = data.documents || [];
    if (!docs.length) {
      teachCorpusList.textContent = 'Файловый корпус пуст.';
      teachCorpusList.hidden = false;
      return;
    }
    const lines = docs.map((d, i) => `${i + 1}. ${d.filename} (${d.kind}, ${d.charCount} зн.)`);
    teachCorpusList.textContent = `В корпусе ${docs.length} файл(ов):\n${lines.join('\n')}`;
    teachCorpusList.hidden = false;
  } catch (error) {
    console.warn(error);
    teachCorpusList.textContent = error.message || 'Не удалось прочитать корпус.';
    teachCorpusList.hidden = false;
  }
}

async function runCorpusUpload() {
  if (!session?.token || teachSessionBusy) return;
  const files = [...(teachCorpusFiles?.files || [])];
  if (!files.length) {
    showTeachSessionStatus('Выберите PDF или DOCX.');
    return;
  }
  teachSessionBusy = true;
  setTeachSessionUi(teachSession);
  let ok = 0;
  const errors = [];
  try {
    for (let i = 0; i < files.length; i += 1) {
      const file = files[i];
      showTeachSessionStatus(`Извлечение ${i + 1}/${files.length}: ${file.name}…`);
      try {
        const extracted = await extractTeachFile(file);
        showTeachSessionStatus(`Загрузка на сервер ${i + 1}/${files.length}: ${file.name}…`);
        await api.adminTeachCorpusAdd(session.token, extracted);
        ok += 1;
      } catch (err) {
        console.warn(err);
        errors.push(`${file.name}: ${err.message || err}`);
      }
    }
    if (teachCorpusFiles) teachCorpusFiles.value = '';
    await refreshCorpusList();
    showTeachSessionStatus(
      `Загружено ${ok}/${files.length}.`
      + (errors.length ? ` Ошибки: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '…' : ''}` : ''),
    );
  } finally {
    teachSessionBusy = false;
    setTeachSessionUi(teachSession);
  }
}

async function runCorpusClear() {
  if (!session?.token || teachSessionBusy) return;
  if (!window.confirm('Очистить весь файловый корпус на сервере?')) return;
  teachSessionBusy = true;
  try {
    await api.adminTeachCorpusClear(session.token);
    await refreshCorpusList();
    showTeachSessionStatus('Файловый корпус очищен.');
  } catch (error) {
    console.warn(error);
    showTeachSessionStatus(error.message || 'Не удалось очистить корпус.');
  } finally {
    teachSessionBusy = false;
    setTeachSessionUi(teachSession);
  }
}

async function runTeachSessionStart(source = 'notion') {
  if (!session?.token || teachSessionBusy) return;
  teachSessionBusy = true;
  setTeachSessionUi(teachSession);
  showTeachSessionStatus(source === 'files' ? 'Старт сессии на файловом корпусе…' : 'Старт сессии Notion…');
  try {
    const { session: started } = await api.adminTeachSessionStart(session.token, { source });
    let current = started;
    setTeachSessionUi(current);
    if (source === 'notion') {
      while (current.status === 'ingesting' && current.progress && !current.progress.done) {
        showTeachSessionStatus(
          `Корпус Notion: ${current.progress.loaded}/${current.progress.total}…`,
        );
        const step = await api.adminTeachSessionIngest(session.token, current.id);
        current = step.session;
        setTeachSessionUi(current);
        if (step.done) break;
      }
    }
    const label = current.corpusKind === 'files' ? 'файлов' : 'глав';
    showTeachSessionStatus(
      `Корпус готов (${current.progress?.total || 0} ${label}). Пишите задачу — Би может спросить.`,
    );
    setTeachSessionUi(current);
  } catch (error) {
    console.warn(error);
    showTeachSessionStatus(error.message || 'Не удалось начать учебную сессию.');
  } finally {
    teachSessionBusy = false;
    setTeachSessionUi(teachSession);
  }
}

async function runTeachSessionSend() {
  if (!session?.token || !teachSession?.id || teachSessionBusy) return;
  const text = (teachSessionInput?.value || '').trim();
  if (!text) return;
  teachSessionBusy = true;
  setTeachSessionUi(teachSession);
  showTeachSessionStatus('Би думает…');
  try {
    if (teachSessionInput) teachSessionInput.value = '';
    const result = await api.adminTeachSessionTurn(session.token, teachSession.id, text);
    setTeachSessionUi(result.session);
    const kindRu = result.reply?.kind === 'question' ? 'вопрос на понимание' : 'ответ';
    showTeachSessionStatus(`Би: ${kindRu}.`);
  } catch (error) {
    console.warn(error);
    showTeachSessionStatus(error.message || 'Ход не удался.');
  } finally {
    teachSessionBusy = false;
    setTeachSessionUi(teachSession);
  }
}

async function runTeachSessionClose() {
  if (!session?.token || !teachSession?.id || teachSessionBusy) return;
  teachSessionBusy = true;
  try {
    const { session: closed } = await api.adminTeachSessionClose(session.token, teachSession.id);
    setTeachSessionUi(closed);
    showTeachSessionStatus('Сессия закрыта.');
  } catch (error) {
    console.warn(error);
    showTeachSessionStatus(error.message || 'Не удалось закрыть сессию.');
  } finally {
    teachSessionBusy = false;
    setTeachSessionUi(teachSession);
  }
}

const roles = { user: 'пользователь', admin: 'администратор' };
const statuses = { active: 'активна', blocked: 'заблокирована' };
const teachLabels = {
  experimental_preliminary_pass: 'предварительный успех (эксперимент)',
  experimental_preliminary_fail: 'предварительный провал (эксперимент)',
};

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function criterionBlock(name, c) {
  const wrap = el('div', 'admin-teach-crit');
  wrap.append(
    el('strong', null, `${name}: ${c?.pass ? 'да' : 'нет'}`),
    el('p', 'note', c?.justification || '—'),
    el('p', 'note', `Источник: ${c?.source_ref || '—'}`),
  );
  return wrap;
}

/** Strip legacy sense/application labels from stored examiner notes. */
function sanitizeExaminerNote(text) {
  return String(text || '')
    .replace(/(^|[;\s])смысл\s*:\s*[^;]*/gi, '$1')
    .replace(/(^|[;\s])применение\s*:\s*[^;]*/gi, '$1')
    .replace(/;\s*;/g, ';')
    .replace(/^[\s;]+|[\s;]+$/g, '')
    .trim();
}

function examinerNoteFromGrade(g) {
  if (!g) return '';
  const bits = [];
  const letter = g.letter;
  if (letter) {
    const cert = letter.certain === true ? ', определённо' : letter.certain === false ? ', сомневается' : '';
    bits.push(`буква: ${letter.pass ? 'да' : 'нет'}${cert}${letter.justification ? ` — ${letter.justification}` : ''}`);
  }
  if (g.spirit) {
    bits.push(`дух: ${g.spirit.pass ? 'да' : 'нет'}${g.spirit.justification ? ` — ${g.spirit.justification}` : ''}`);
  }
  if (g.error_summary) bits.push(`ошибки: ${g.error_summary}`);
  return bits.join('; ');
}

function attachRulingForm(card, {
  fragmentId, taskId, taskPrompt, pupilAnswer, examinerNote,
}) {
  const btn = el('button', 'btn', 'Не согласен');
  btn.type = 'button';
  const form = el('div', 'admin-teach-ruling');
  form.hidden = true;

  const ta = document.createElement('textarea');
  ta.rows = 4;
  ta.placeholder = 'Замечание Создателя (открытый вопрос; окончательный ответ не обязателен)…';
  const src = document.createElement('input');
  src.type = 'text';
  src.placeholder = 'Опора на источник (необязательно)';
  const save = el('button', 'btn btn-primary', 'Сохранить разногласие');
  save.type = 'button';
  const cancel = el('button', 'btn', 'Отмена');
  cancel.type = 'button';
  const note = el('p', 'note', '');
  note.hidden = true;
  const actions = el('div', 'admin-teach-ruling-actions');
  actions.append(save, cancel);
  form.append(ta, src, actions, note);

  btn.addEventListener('click', () => {
    form.hidden = false;
    btn.hidden = true;
    ta.focus();
  });
  cancel.addEventListener('click', () => {
    form.hidden = true;
    btn.hidden = false;
    note.hidden = true;
  });
  save.addEventListener('click', () => act(async () => {
    if (!session?.token) return;
    save.disabled = true;
    try {
      const res = await api.adminTeachDispute(session.token, {
        fragmentId,
        taskId,
        taskPrompt,
        pupilAnswer,
        examinerNote,
        creatorRemark: ta.value,
        sourceRef: src.value,
      });
      note.textContent = res.note || 'Разногласие сохранено (open).';
      note.hidden = false;
      ta.disabled = true;
      src.disabled = true;
      save.hidden = true;
      cancel.hidden = true;
      await loadDisputes();
    } finally {
      save.disabled = false;
    }
  }));

  card.append(btn, form);
}

function renderRound(title, round, fragmentId) {
  const section = el('section', 'admin-teach-round');
  section.append(el('h3', null, title));
  if (!round) {
    section.append(el('p', 'note', 'Нет данных.'));
    return section;
  }

  if (round.principles) {
    section.append(el('h4', null, 'Принципы Ученика'));
    const ul = el('ul');
    for (const p of round.principles.list || []) ul.append(el('li', null, p));
    section.append(ul);
    if (round.principles.summary) section.append(el('p', 'note', round.principles.summary));
  }

  const tasks = round.tasks || [];
  const answers = new Map((round.answers || []).map((a) => [String(a.task_id), a]));
  const grades = new Map((round.grades || []).map((g) => [String(g.task_id), g]));

  tasks.forEach((task, i) => {
    const card = el('article', 'admin-teach-task');
    card.append(el('h4', null, `Задача ${task.id || i + 1}`));
    card.append(el('p', null, task.prompt || ''));
    if (task.novelty?.reason) {
      card.append(el('p', 'note', `Новизна: ${task.novelty.reason}`));
    }
    const ans = answers.get(String(task.id));
    card.append(el('h5', null, 'Ответ Ученика'));
    card.append(el('p', null, ans?.answer || '—'));
    const g = grades.get(String(task.id));
    if (g) {
      card.append(el('h5', null, 'Оценка'));
      card.append(criterionBlock(
        g.letter?.certain === false ? 'Буква (сомневается)' : 'Буква',
        g.letter,
      ));
      if (g.spirit) {
        card.append(criterionBlock('Дух', g.spirit));
      } else {
        card.append(el('p', 'note', 'Дух не нужен: буква дала определённый ответ.'));
      }
      if (g.error_summary) card.append(el('p', 'note', `Ошибки: ${g.error_summary}`));
    }
    if (fragmentId) {
      attachRulingForm(card, {
        fragmentId,
        taskId: String(task.id || `t${i + 1}`),
        taskPrompt: task.prompt || '',
        pupilAnswer: ans?.answer || '',
        examinerNote: examinerNoteFromGrade(g),
      });
    }
    section.append(card);
  });

  if (round.overall_note) section.append(el('p', 'note', `Заметка Экзаменатора: ${round.overall_note}`));
  return section;
}

function renderTeachReport(report) {
  teachResult.replaceChildren();
  teachResult.hidden = false;

  teachResult.append(el('p', 'admin-teach-disclaimer', report.disclaimer || ''));
  const statusLine = el('p', 'admin-teach-final');
  statusLine.append(
    el('strong', null, 'Итог: '),
    document.createTextNode(teachLabels[report.status] || report.status || '—'),
  );
  teachResult.append(statusLine);
  const frag = report.fragmentId || report.methodist?.fragmentId || '—';
  teachResult.append(el('p', 'note', `${frag} · ${report.methodist?.title || ''}`));
  teachResult.append(el('p', 'note', `Цель: ${report.methodist?.learningGoal || '—'}`));
  teachResult.append(el(
    'p',
    'note',
    `Источник: ${report.source?.title || ''} (${report.source?.charCount || 0} символов). ${report.source?.scope || ''}`,
  ));
  const applied = Number(report.creatorRulingsApplied || 0);
  teachResult.append(el(
    'p',
    'note',
    applied
      ? `Учтено разногласий Создателя (open/resolved) с прошлых циклов: ${applied}.`
      : 'Разногласий для этого фрагмента пока нет. «Не согласен» сразу открывает запись в журнале.',
  ));

  teachResult.append(renderRound('Раунд 1', {
    ...report.round1,
    principles: report.round1?.principles,
  }, frag));

  if (report.retest) {
    teachResult.append(renderRound('Повторный экзамен', report.retest, frag));
  } else {
    teachResult.append(el('p', 'note', 'Повторный экзамен не потребовался или не выполнялся.'));
  }

  if (report.usage) {
    teachResult.append(el('p', 'note', `Вызовов модели: ${report.usage.calls}; стоимость (оценка): $${((report.usage.costMicros || 0) / 1_000_000).toFixed(4)} из бюджета чата.`));
  }
}

async function loadUsers() {
  const { users } = await api.adminUsers(session.token);
  rows.replaceChildren(...users.map((user) => {
    const tr = document.createElement('tr');
    tr.append(
      cell(user.id.slice(0, 8)),
      cell(roles[user.role] ?? user.role),
      cell(statuses[user.status] ?? user.status),
      cell(new Date(user.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })),
      cell(String(user.passkeys)),
    );
    return tr;
  }));
  $('admin-count').textContent = `(${users.length})`;
}

async function renderDisputeDetail(id) {
  if (!session?.token || !disputeDetail) return;
  const packed = await api.adminTeachDisputeGet(session.token, id);
  const d = packed.dispute;
  disputeDetail.hidden = false;
  disputeDetail.replaceChildren();
  disputeDetail.append(el('h3', null, `${d.fragmentId} / ${d.taskId || '—'} · ${disputeStatusRu[d.status] || d.status}`));
  disputeDetail.append(el('p', 'note', `id: ${d.id}`));
  disputeDetail.append(el('p', null, d.taskPrompt || '—'));
  disputeDetail.append(el('h4', null, 'Ответ Би'));
  disputeDetail.append(el('p', null, d.pupilAnswer || '—'));
  disputeDetail.append(el('h4', null, 'Экзаменатор'));
  disputeDetail.append(el('p', 'note', sanitizeExaminerNote(d.examinerNote) || '—'));
  disputeDetail.append(el('h4', null, 'История'));
  for (const m of packed.messages || []) {
    const line = el('p', 'admin-dispute-msg');
    line.append(
      el('strong', null, `${m.role}/${m.kind}: `),
      document.createTextNode(m.body),
    );
    disputeDetail.append(line);
  }

  if (d.status === 'open') {
    const talk = document.createElement('textarea');
    talk.rows = 3;
    talk.placeholder = 'Реплика Создателя для обсуждения с Би…';
    const discussBtn = el('button', 'btn btn-primary', 'Обсудить с Би');
    discussBtn.type = 'button';
    discussBtn.addEventListener('click', () => act(async () => {
      discussBtn.disabled = true;
      try {
        await api.adminTeachDisputeDiscuss(session.token, {
          disputeId: d.id,
          creatorMessage: talk.value,
        });
        talk.value = '';
        await renderDisputeDetail(d.id);
        await loadDisputes();
      } finally {
        discussBtn.disabled = false;
      }
    }));

    const formulation = document.createElement('textarea');
    formulation.rows = 3;
    formulation.placeholder = 'Подтверждённый вывод для записи в учения (обязателен при закрытии)…';
    const resolveStatus = document.createElement('select');
    for (const [value, label] of [
      ['resolved_bi_error', 'Ошибка Би'],
      ['resolved_examiner_error', 'Ошибка Экзаменатора'],
      ['resolved_other', 'Иное объяснение'],
    ]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      resolveStatus.append(opt);
    }
    const resolveBtn = el('button', 'btn', 'Закрыть разногласие');
    resolveBtn.type = 'button';
    resolveBtn.addEventListener('click', () => act(async () => {
      resolveBtn.disabled = true;
      try {
        await api.adminTeachDisputeResolve(session.token, {
          disputeId: d.id,
          status: resolveStatus.value,
          formulation: formulation.value,
          resolutionNote: formulation.value,
        });
        await renderDisputeDetail(d.id);
        await loadDisputes();
      } finally {
        resolveBtn.disabled = false;
      }
    }));

    disputeDetail.append(el('h4', null, 'Обсуждение'));
    disputeDetail.append(talk, discussBtn);
    disputeDetail.append(el('h4', null, 'Разрешение (только Создатель)'));
    disputeDetail.append(resolveStatus, formulation, resolveBtn);
  } else if (d.teachingId) {
    disputeDetail.append(el('p', 'note', `Учение: ${d.teachingId}`));
  }
}

async function loadDisputes() {
  if (!session?.token || !disputesList) return;
  const { disputes } = await api.adminTeachDisputes(session.token, {});
  disputesList.replaceChildren();
  if (!disputes?.length) {
    disputesList.append(el('p', 'note', 'Журнал пуст.'));
    return;
  }
  for (const d of disputes) {
    const card = el('article', 'admin-teach-task');
    card.append(el(
      'h4',
      null,
      `${d.fragmentId} / ${d.taskId || '—'} · ${disputeStatusRu[d.status] || d.status}`,
    ));
    card.append(el('p', 'note', new Date(d.updatedAt || d.createdAt).toLocaleString('ru-RU')));
    card.append(el('p', null, d.creatorRemark || ''));
    const openBtn = el('button', 'btn', 'Открыть');
    openBtn.type = 'button';
    openBtn.addEventListener('click', () => act(() => renderDisputeDetail(d.id)));
    card.append(openBtn);
    disputesList.append(card);
  }
}

async function loadFragments() {
  if (!session?.token || !teachFragment) return;
  const data = await api.adminTeachFragments(session.token);
  const frags = data.fragments || [];
  teachFragment.replaceChildren();
  for (const f of frags) {
    const opt = document.createElement('option');
    opt.value = f.fragmentId;
    opt.textContent = `${f.fragmentId} — ${f.title}`;
    teachFragment.append(opt);
  }
  const manual = $('admin-manual-fragment');
  if (manual) {
    manual.replaceChildren();
    for (const f of frags) {
      const opt = document.createElement('option');
      opt.value = f.fragmentId;
      opt.textContent = f.fragmentId;
      manual.append(opt);
    }
  }
}

function showChainStatus(text) {
  if (!teachChainStatus) return;
  teachChainStatus.textContent = text;
  teachChainStatus.hidden = !text;
}

function formatChainOutcome(run, stopKind) {
  const results = run.results || [];
  const passed = results.filter((r) => r.status === 'experimental_preliminary_pass').map((r) => r.fragmentId);
  const last = [...results].reverse().find((r) => r.status === 'error' || r.status === 'experimental_preliminary_fail' || r.status === 'experimental_preliminary_pass') || results[results.length - 1];
  const kind = stopKind
    || last?.stopKind
    || (run.status === 'failed' || last?.status === 'error' ? 'technical'
      : run.status === 'paused' && /разноглас/i.test(run.pauseReason || '') ? 'open_dispute'
        : run.status === 'paused' && /ТЕХСБОЙ/i.test(run.pauseReason || '') ? 'technical'
          : run.status === 'paused' ? 'pupil_fail'
            : run.status === 'completed' ? 'completed' : 'other');

  const kindRu = {
    technical: 'техсбой (Экзаменатор/источник) — префикс сохранён, следующий запуск продолжит с этого блока',
    technical_retry: 'автоповтор того же блока',
    pupil_fail: 'провал учения (Экзаменатор не зачёл буква/дух)',
    open_dispute: 'пауза из‑за открытого разногласия в журнале',
    completed: 'цепочка завершена',
    other: run.status,
  }[kind] || kind;

  const lines = [
    `Итог: ${run.status === 'completed' ? 'готово' : 'остановлена'} · причина: ${kindRu}`,
  ];
  if (run.pauseReason) lines.push(run.pauseReason);
  if (run.resumed && run.resumeFrom) {
    lines.push(`Продолжение с ${run.resumeFrom} (начало цепочки не перепрогонялось).`);
  }
  if (passed.length) lines.push(`Успешно пройдены: ${passed.join(', ')}.`);
  if (last?.status === 'error') {
    lines.push(`Сломался фрагмент: ${last.fragmentId} (${last.error || 'error'}).`);
  }
  if (last?.status === 'experimental_preliminary_fail') {
    lines.push(`Не зачтён фрагмент: ${last.fragmentId}. Отчёт этого фрагмента — ниже.`);
  }
  return lines.join('\n');
}

async function runTeachChain() {
  if (!session?.token || teachRunning) return;
  teachRunning = true;
  teachBtn.disabled = true;
  if (teachChainBtn) teachChainBtn.disabled = true;
  if (teachFragment) teachFragment.disabled = true;
  teachResult.hidden = true;
  teachResult.replaceChildren();
  showTeachStatus('Цепочка F01–F15: старт или продолжение с последнего непройденного…');
  showChainStatus('');
  try {
    const { run } = await api.adminTeachChainStart(session.token, {});
    let current = run;
    let lastReport = null;
    let lastStopKind = null;
    if (run.resumed && run.resumeFrom) {
      const prefix = (run.carriedPrefix || []).join(', ') || 'префикс сохранён';
      showChainStatus(`Продолжаем с ${run.resumeFrom}. Уже зачтено без перепрогона: ${prefix}.`);
    }
    while (current.status === 'running' && current.nextFragmentId) {
      const label = current.pauseReason?.startsWith('АВТОПОВТОР')
        ? current.pauseReason
        : `Цепочка: выполняется ${current.nextFragmentId} (${current.cursorIndex + 1}/${current.fragmentIds.length})…`;
      showTeachStatus(label);
      const step = await api.adminTeachChainContinue(session.token, current.id);
      current = step.run;
      if (step.stopKind === 'technical_retry') {
        lastStopKind = 'technical_retry';
        showChainStatus(step.run.pauseReason || `Автоповтор ${step.techAttempt}/${step.techRetryLimit}`);
        continue;
      }
      lastStopKind = step.stopKind || lastStopKind;
      if (step.report) {
        lastReport = step.report;
        renderTeachReport(step.report);
      }
      if (step.stopped) break;
    }
    showTeachStatus('');
    showChainStatus(formatChainOutcome(current, lastStopKind));
    // Only keep a fragment report when it explains the stop (pupil fail) or the chain finished.
    // Tech/dispute stops have no grading report — clearing avoids showing the previous fragment's exam.
    if (lastStopKind === 'pupil_fail' && lastReport) {
      renderTeachReport(lastReport);
    } else if (current.status === 'completed' && lastReport) {
      renderTeachReport(lastReport);
    } else if (lastStopKind === 'technical' || lastStopKind === 'open_dispute' || current.status === 'failed' || current.status === 'paused') {
      teachResult.replaceChildren();
      teachResult.hidden = false;
      const techHint = lastStopKind === 'technical'
        ? ' Техсбой: Создателя звать не нужно — снова «Запустить цепочку» продолжит с этого блока.'
        : '';
      teachResult.append(el(
        'p',
        'admin-teach-disclaimer',
        `Отчёта экзамена по остановившему фрагменту нет: цепочка встала до итоговой оценки Ученика (см. причину выше).${techHint}`,
      ));
    }
  } catch (error) {
    console.warn(error);
    showTeachStatus(error.message || 'Цепочку не удалось выполнить.');
  } finally {
    teachRunning = false;
    teachBtn.disabled = false;
    if (teachChainBtn) teachChainBtn.disabled = false;
    if (teachFragment) teachFragment.disabled = false;
  }
}

async function show() {
  const admin = Boolean(session?.user.admin);
  panel.hidden = !admin;
  signedOut.hidden = admin;
  if (admin) {
    await loadUsers();
    await loadFragments();
    await loadDisputes();
    await refreshCorpusList();
  } else if (session) showStatus('Эта учётная запись не администратор, или вход был без passkey с отпечатком, лицом или PIN-кодом.');
}

async function act(action) {
  showStatus('');
  try {
    await action();
  } catch (error) {
    console.warn(error);
    showStatus(error.message || 'Что-то пошло не так. Попробуйте ещё раз.');
  }
}

async function runTeachCycle() {
  if (!session?.token || teachRunning) return;
  const fragmentId = teachFragment?.value || 'F01';
  teachRunning = true;
  teachBtn.disabled = true;
  if (teachFragment) teachFragment.disabled = true;
  teachResult.hidden = true;
  teachResult.replaceChildren();
  showTeachStatus(`Обучение ${fragmentId} выполняется (несколько вызовов модели, обычно 1–3 минуты)…`);
  try {
    const report = await api.adminTeachRun(session.token, fragmentId);
    showTeachStatus('');
    renderTeachReport(report);
  } catch (error) {
    console.warn(error);
    showTeachStatus(error.message || 'Обучение не удалось выполнить.');
  } finally {
    teachRunning = false;
    teachBtn.disabled = false;
    if (teachFragment) teachFragment.disabled = false;
  }
}

$('admin-login').addEventListener('click', () => act(async () => {
  const result = await signInWithPasskey(storage);
  session = { token: (await storage.getAccount()).token, user: result.user };
  await show();
}));

$('admin-refresh').addEventListener('click', () => act(loadUsers));

$('admin-logout').addEventListener('click', () => act(async () => {
  await signOut(storage);
  session = null;
  rows.replaceChildren();
  teachResult.hidden = true;
  teachResult.replaceChildren();
  showTeachStatus('');
  await show();
}));

teachCorpusUploadBtn?.addEventListener('click', () => act(runCorpusUpload));
teachCorpusClearBtn?.addEventListener('click', () => act(runCorpusClear));
teachSessionFilesBtn?.addEventListener('click', () => act(() => runTeachSessionStart('files')));
teachSessionStartBtn?.addEventListener('click', () => act(() => runTeachSessionStart('notion')));
teachSessionSendBtn?.addEventListener('click', () => act(runTeachSessionSend));
teachSessionCloseBtn?.addEventListener('click', () => act(runTeachSessionClose));
teachSessionInput?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    act(runTeachSessionSend);
  }
});

teachBtn?.addEventListener('click', () => act(runTeachCycle));
teachChainBtn?.addEventListener('click', () => act(runTeachChain));

$('admin-disputes-refresh')?.addEventListener('click', () => act(loadDisputes));

$('admin-dispute-manual-toggle')?.addEventListener('click', () => {
  if (!disputeManual) return;
  disputeManual.hidden = !disputeManual.hidden;
});

$('admin-dispute-manual-save')?.addEventListener('click', () => act(async () => {
  if (!session?.token) return;
  await api.adminTeachDispute(session.token, {
    fragmentId: $('admin-manual-fragment')?.value || 'F02',
    taskId: $('admin-manual-task')?.value || '',
    taskPrompt: $('admin-manual-prompt')?.value || '',
    pupilAnswer: $('admin-manual-answer')?.value || '',
    examinerNote: $('admin-manual-examiner')?.value || '',
    creatorRemark: $('admin-manual-remark')?.value || '',
  });
  if (disputeManual) disputeManual.hidden = true;
  showStatus('Разногласие сохранено в журнал.');
  await loadDisputes();
}));

if (!api.configured) {
  showStatus('Сервер Buddy ещё не подключён.');
} else {
  await act(async () => {
    session = await currentUser(storage);
    await show();
  });
}
