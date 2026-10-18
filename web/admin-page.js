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
const teachBtn = $('admin-teach-f01');

const storage = await openStorage();
let session = null;
let teachRunning = false;

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

function renderRound(title, round) {
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
  teachResult.append(el('p', 'note', `Цель F01: ${report.methodist?.learningGoal || '—'}`));
  teachResult.append(el(
    'p',
    'note',
    `Источник: ${report.source?.title || ''} (${report.source?.charCount || 0} символов). ${report.source?.scope || ''}`,
  ));

  teachResult.append(renderRound('Раунд 1', {
    ...report.round1,
    principles: report.round1?.principles,
  }));

  if (report.retest) {
    teachResult.append(renderRound('Повторный экзамен', report.retest));
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

async function show() {
  const admin = Boolean(session?.user.admin);
  panel.hidden = !admin;
  signedOut.hidden = admin;
  if (admin) await loadUsers();
  else if (session) showStatus('Эта учётная запись не администратор, или вход был без passkey с отпечатком, лицом или PIN-кодом.');
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

async function runTeachF01() {
  if (!session?.token || teachRunning) return;
  teachRunning = true;
  teachBtn.disabled = true;
  teachResult.hidden = true;
  teachResult.replaceChildren();
  showTeachStatus('Эксперимент F01 выполняется (несколько вызовов модели, обычно 1–3 минуты)…');
  try {
    const report = await api.adminTeachF01Run(session.token);
    showTeachStatus('');
    renderTeachReport(report);
  } catch (error) {
    console.warn(error);
    showTeachStatus(error.message || 'Эксперимент не удалось выполнить.');
  } finally {
    teachRunning = false;
    teachBtn.disabled = false;
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

teachBtn.addEventListener('click', () => act(runTeachF01));

if (!api.configured) {
  showStatus('Сервер Buddy ещё не подключён.');
} else {
  await act(async () => {
    session = await currentUser(storage);
    await show();
  });
}
