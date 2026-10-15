import { registerServiceWorker } from './pwa.js';
import { openStorage } from './storage.js';
import {
  joinEntries, exportJournal, exportFileName, describeFact, normalizeRating,
  statusLabels, checkerLabels, answerLabels, RATING_QUESTION, MAX_COMMENT_LENGTH,
} from './journal.js';

registerServiceWorker();

const list = document.getElementById('journal-list');
const empty = document.getElementById('journal-empty');
const status = document.getElementById('journal-status');
const exportButton = document.getElementById('journal-export');
const clearButton = document.getElementById('journal-clear');

const storage = await openStorage();
const declarations = await loadDeclarations();
let entries = [];

async function loadDeclarations() {
  try {
    const response = await fetch('declarations.json');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    return { version: data.version, titles: new Map(data.declarations.map((d) => [d.id, d.title])) };
  } catch (error) {
    console.warn('Декларации не загрузились:', error);
    return { version: null, titles: new Map() };
  }
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.filter((child) => child !== null && child !== undefined));
  return node;
}

function showStatus(text) {
  status.textContent = text;
  status.hidden = false;
}

function declarationLink(id) {
  const title = declarations.titles.get(id);
  return el('a', { href: `declarations.html#${id}` }, title ? `${id}. ${title}` : id);
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'long', timeStyle: 'short' });
}

function renderExplanation(explanation) {
  if (!explanation) return el('p', { class: 'note' }, 'Объяснения нет.');
  const rows = [
    ['Ситуация', explanation.situation],
    ['Цель', explanation.goal],
    ['Решение', explanation.decision],
    ['Мотив', explanation.motive],
  ].filter(([, value]) => value);
  const refs = explanation.declarations ?? [];
  const dl = el('dl', { class: 'journal-dl' });
  for (const [term, value] of rows) dl.append(el('dt', {}, term), el('dd', {}, value));
  if (refs.length) {
    const dd = el('dd');
    refs.forEach((id, i) => dd.append(i ? ', ' : '', declarationLink(id)));
    dl.append(el('dt', {}, 'Ссылается на'), dd);
  }
  const source = explanation.source === 'script' ? 'Так Би объясняет свой поступок. Текст объяснения заранее написан в сценарии знакомства.' : 'Так Би объясняет свой поступок.';
  return [el('p', { class: 'note' }, source), dl];
}

function renderActions(actions) {
  if (!actions) return el('p', { class: 'note' }, 'Программа ничего не записала.');
  return [
    el('p', { class: 'note' }, 'Записано программой, а не Би.'),
    actions.facts.length
      ? el('ul', {}, ...actions.facts.map((fact) => el('li', {}, describeFact(fact))))
      : el('p', {}, 'Действий, которые нужно записывать, не было.'),
    actions.result ? el('p', {}, el('strong', {}, 'Результат: '), actions.result) : null,
  ];
}

function renderCompliance(compliance) {
  if (!compliance) return el('p', { class: 'note' }, 'Проверки нет.');
  return el('ul', { class: 'compliance' }, ...compliance.results.map((item) => el('li', {},
    declarationLink(item.id), ' ',
    el('span', { class: `badge badge-${item.status}` }, statusLabels[item.status] ?? item.status),
    el('br'),
    el('span', { class: 'note' }, `Проверил: ${checkerLabels[item.checkedBy] ?? item.checkedBy}. ${item.basis}`),
  )));
}

function verdict(compliance) {
  if (!compliance) return el('span', { class: 'badge badge-unchecked' }, 'не проверено');
  const violated = compliance.results.some((item) => item.status === 'violated');
  return violated
    ? el('span', { class: 'badge badge-violated' }, 'есть нарушение')
    : el('span', { class: 'badge badge-kept' }, 'нарушений не найдено');
}

function renderRating(entry) {
  let answer = entry.rating?.answer ?? null;
  const buttons = Object.entries(answerLabels).map(([value, label]) => {
    const button = el('button', { type: 'button', class: 'btn btn-secondary btn-small', 'aria-pressed': String(answer === value) }, label);
    button.addEventListener('click', () => {
      answer = value;
      for (const other of buttons) other.setAttribute('aria-pressed', String(other === button));
    });
    return button;
  });
  const commentId = `comment-${entry.eventId}`;
  const comment = el('textarea', { id: commentId, rows: '2', maxlength: String(MAX_COMMENT_LENGTH), placeholder: 'Комментарий — необязательно' });
  comment.value = entry.rating?.comment ?? '';
  const save = el('button', { type: 'button', class: 'btn btn-primary btn-small' }, 'Сохранить оценку');
  const note = el('p', { class: 'note', role: 'status' }, entry.rating ? `Оценка от ${formatTime(entry.rating.at)}.` : 'Оценки пока нет.');
  save.addEventListener('click', async () => {
    const result = normalizeRating({ answer, comment: comment.value });
    if (!result.ok) {
      note.textContent = result.error;
      return;
    }
    await storage.rateEvent(entry.eventId, result.rating);
    entry.rating = result.rating;
    note.textContent = `Оценка сохранена: ${answerLabels[answer]}.`;
  });
  return el('div', { class: 'journal-rating' },
    el('p', {}, el('strong', {}, RATING_QUESTION)),
    el('div', { class: 'rating-buttons', role: 'group', 'aria-label': 'Оценка' }, ...buttons),
    el('label', { for: commentId, class: 'visually-hidden' }, 'Комментарий'),
    comment,
    save,
    note,
  );
}

function section(title, content) {
  return el('details', { class: 'journal-part' }, el('summary', {}, title), ...[content].flat());
}

function renderEntry(entry) {
  return el('li', { class: 'card journal-entry' },
    el('h2', {}, entry.title ?? entry.kind),
    el('p', { class: 'note' }, formatTime(entry.at), ' · ', verdict(entry.compliance)),
    section('Объяснение Би', renderExplanation(entry.explanation)),
    section('Что сделала программа', renderActions(entry.actions)),
    section('Проверка по декларациям', renderCompliance(entry.compliance)),
    renderRating(entry),
  );
}

async function render() {
  entries = joinEntries(await storage.readJournal());
  list.replaceChildren(...entries.map(renderEntry));
  empty.hidden = entries.length > 0;
  exportButton.disabled = entries.length === 0;
  clearButton.disabled = entries.length === 0;
}

exportButton.addEventListener('click', () => {
  const data = exportJournal(entries, { declarationsVersion: declarations.version });
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const name = exportFileName();
  const link = el('a', { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showStatus(`Журнал сохранён в файл ${name}. Записей: ${entries.length}.`);
});

clearButton.addEventListener('click', async () => {
  if (!window.confirm('Удалить все записи журнала с этого устройства? Имя, голос и история разговора останутся. Восстановить журнал будет нельзя.')) return;
  await storage.clearJournal();
  await render();
  showStatus('Журнал удалён.');
});

if (!storage.persistent) showStatus('Браузер не даёт сохранять данные — например, в приватном режиме. Журнал здесь недоступен.');
await render();
