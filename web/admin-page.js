import { registerServiceWorker } from './pwa.js';
import { openStorage } from './storage.js';
import { api } from './api.js';
import { currentUser, signInWithPasskey, signOut } from './account.js';

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
const disputesList = $('admin-disputes-list');
const disputeDetail = $('admin-dispute-detail');
const disputeManual = $('admin-dispute-manual');

const storage = await openStorage();
let session = null;
let teachRunning = false;
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

function examinerNoteFromGrade(g) {
  if (!g) return '';
  const bits = [];
  for (const [name, key] of [['буква', 'letter'], ['смысл', 'sense'], ['применение', 'application'], ['дух', 'spirit']]) {
    const c = g[key];
    if (!c) continue;
    bits.push(`${name}: ${c.pass ? 'да' : 'нет'}${c.justification ? ` — ${c.justification}` : ''}`);
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
      card.append(criterionBlock('Буква', g.letter));
      card.append(criterionBlock('Смысл', g.sense));
      card.append(criterionBlock('Применение', g.application));
      card.append(criterionBlock('Дух', g.spirit));
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
  disputeDetail.append(el('p', 'note', d.examinerNote || '—'));
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

async function show() {
  const admin = Boolean(session?.user.admin);
  panel.hidden = !admin;
  signedOut.hidden = admin;
  if (admin) {
    await loadUsers();
    await loadDisputes();
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

teachBtn.addEventListener('click', () => act(runTeachCycle));

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
