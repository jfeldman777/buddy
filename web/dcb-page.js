import { registerServiceWorker } from './pwa.js';
import { openStorage } from './storage.js';
import { api } from './api.js';
import { currentUser } from './account.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const status = $('dcb-status');
const storage = await openStorage();

let auth = null;
let personas = [];
let current = null;
/** @type {string|null|undefined} undefined = leave unchanged on patch; null = clear; string = data URL */
let pendingPhoto = undefined;
const SEGMENT_PAIRS = 15;
const PHOTO_MAX_EDGE = 512;
const PHOTO_JPEG_QUALITY = 0.72;

function showStatus(text) {
  status.textContent = text;
  status.hidden = !text;
  if (text) status.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function dollars(micros) {
  return (micros / 1_000_000).toFixed(4);
}

async function act(action) {
  showStatus('');
  try {
    await action();
  } catch (error) {
    console.warn(error);
    showStatus(error.message || 'Ошибка.');
  }
}

function renderBudget(budget) {
  const model = budget.model ? ` · модель ${budget.model}` : '';
  $('dcb-budget').textContent = `Бюджет DCB: осталось $${dollars(budget.remainingMicros)} из $${dollars(budget.grantedMicros)} (потрачено $${dollars(budget.spentMicros)})${model}.`;
}

function setPhotoPreview(dataUrl) {
  const wrap = $('dcb-persona-photo-preview-wrap');
  const img = $('dcb-persona-photo-preview');
  if (dataUrl) {
    img.src = dataUrl;
    wrap.hidden = false;
  } else {
    img.removeAttribute('src');
    wrap.hidden = true;
  }
}

function resetPhotoForm() {
  pendingPhoto = undefined;
  $('dcb-persona-photo').value = '';
  setPhotoPreview(null);
}

async function fileToPhotoDataUrl(file) {
  if (!file || !/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    throw new Error('Нужно фото JPEG, PNG или WebP.');
  }
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
    if (dataUrl.length > 340_000) throw new Error('Фото слишком большое даже после сжатия. Выберите другое.');
    return dataUrl;
  } finally {
    bitmap.close?.();
  }
}

function renderPersonas() {
  const list = $('dcb-persona-list');
  list.replaceChildren(...personas.map((p) => {
    const li = document.createElement('li');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'link-button';
    open.textContent = p.hasPhoto ? `${p.title} · фото` : p.title;
    open.addEventListener('click', () => act(async () => {
      const { persona } = await api.dcbGetPersona(auth.token, p.id);
      $('dcb-persona-id').value = persona.id;
      $('dcb-persona-title').value = persona.title;
      $('dcb-persona-bio').value = persona.secretBio;
      pendingPhoto = undefined;
      $('dcb-persona-photo').value = '';
      setPhotoPreview(persona.photoData || null);
      $('dcb-persona-reset').hidden = false;
      $('dcb-start-persona').value = persona.id;
    }));
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-secondary btn-small';
    del.textContent = 'Удалить';
    del.addEventListener('click', () => act(async () => {
      if (!window.confirm(`Удалить Си «${p.title}»?`)) return;
      await api.dcbDeletePersona(auth.token, p.id);
      await refreshPersonas();
      showStatus('Си удалён.');
    }));
    li.append(open, ' ', del);
    return li;
  }));
  const select = $('dcb-start-persona');
  select.replaceChildren(...personas.map((p) => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.title;
    return opt;
  }));
  $('dcb-start-form').hidden = personas.length === 0;
}

async function refreshPersonas() {
  const data = await api.dcbPersonas(auth.token);
  personas = data.personas;
  renderPersonas();
}

async function refreshSessions() {
  const { sessions } = await api.dcbSessions(auth.token);
  const list = $('dcb-session-list');
  list.replaceChildren(...sessions.map((s) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-button';
    btn.textContent = `${s.personaTitle} · ${s.mode === 'large' ? 'большой' : 'малый'} · ${s.status} · ${new Date(s.startedAt).toLocaleString('ru-RU')}`;
    btn.addEventListener('click', () => act(async () => {
      const { session } = await api.dcbGetSession(auth.token, s.id);
      showSession(session);
    }));
    li.append(btn);
    return li;
  }));
}

function showSession(session) {
  current = session;
  renderBudget(session.budget);
  $('dcb-session').hidden = false;
  const mode = session.mode === 'large' ? 'большой' : 'малый';
  const statusLabel = { running: 'идёт', paused: 'пауза', finished: 'завершён' }[session.status] ?? session.status;
  const photoNote = session.hasPhoto ? ' · фото для Би' : '';
  $('dcb-session-meta').textContent = `${session.personaTitle} · режим ${mode} · ${statusLabel} · вопросов Би: ${session.questionCount} · стратегия ${session.biStrategyVersion}${photoNote}`;
  const active = session.status === 'running' || session.status === 'paused';
  $('dcb-pause').hidden = session.status !== 'running';
  $('dcb-resume').hidden = session.status !== 'paused';
  $('dcb-segment').hidden = !active;
  $('dcb-step').hidden = !active;
  $('dcb-promote').hidden = session.mode === 'large' || session.status === 'finished';
  $('dcb-finish').hidden = session.status === 'finished';
  $('dcb-secret').textContent = session.secretBio ?? '';

  const pairs = session.messages.filter((m) => m.speaker === 'bi').length;
  $('dcb-log-count').textContent = pairs ? `(пар реплик: ${pairs})` : '';
  const log = $('dcb-log');
  log.replaceChildren(...session.messages.map((m) => {
    const li = document.createElement('li');
    li.className = `msg msg-${m.speaker === 'bi' ? 'bi' : 'user'}`;
    li.textContent = `${m.speaker === 'bi' ? 'Би' : 'Си'}: ${m.text}`;
    return li;
  }));

  const model = session.biModel;
  $('dcb-bi-model').textContent = [
    'Факты:',
    ...(model.facts.length ? model.facts.map((f) => `• ${f}`) : ['• —']),
    '',
    'Предположения:',
    ...(model.hypotheses.length ? model.hypotheses.map((f) => `• ${f}`) : ['• —']),
    '',
    'Неясности:',
    ...(model.unknowns.length ? model.unknowns.map((f) => `• ${f}`) : ['• —']),
    '',
    'Биография:',
    model.biography || '—',
  ].join('\n');

  $('dcb-memory').replaceChildren(...session.memory.map((m) => {
    const li = document.createElement('li');
    li.textContent = `[${m.source === 'from_si' ? 'Си' : 'Ди'}] ${m.fact}`;
    return li;
  }));

  const finished = session.status === 'finished';
  $('dcb-review-section').hidden = !finished;
  $('dcb-ideas-section').hidden = !finished;
  if (finished) {
    $('dcb-report').replaceChildren(
      elReport('Исходное описание Си', session.secretBio),
      elReport('Восстановленная Би биография', model.biography || '—'),
      elReport('Установленные факты Би', model.facts.join('\n') || '—'),
      elReport('Предположения', model.hypotheses.join('\n') || '—'),
      elReport('Неясности', model.unknowns.join('\n') || '—'),
      elReport('Факты памяти сеанса', session.memory.map((m) => `[${m.source}] ${m.fact}`).join('\n') || '—'),
      elReport('Число вопросов / длительность', `${session.questionCount} · ${duration(session.startedAt, session.finishedAt)}`),
    );
    if (session.review) {
      $('dcb-score').value = String(session.review.score);
      $('dcb-good').value = session.review.good ?? '';
      $('dcb-mistakes').value = session.review.mistakes ?? '';
      $('dcb-missed').value = session.review.missed ?? '';
      $('dcb-comment').value = session.review.comment ?? '';
    }
    if (session.ideas) {
      $('dcb-idea-strategy').value = session.ideas.strategy ?? '';
      $('dcb-idea-acquaintance').value = session.ideas.acquaintance ?? '';
      $('dcb-idea-si').value = session.ideas.siNotes ?? '';
      $('dcb-idea-next').value = session.ideas.nextTrials ?? '';
    }
  }
}

function elReport(title, text) {
  const box = document.createElement('div');
  box.className = 'dcb-report-block';
  const h = document.createElement('h3');
  h.textContent = title;
  const pre = document.createElement('pre');
  pre.className = 'dcb-pre';
  pre.textContent = text;
  box.append(h, pre);
  return box;
}

function duration(start, end) {
  if (!start || !end) return '—';
  const ms = new Date(end) - new Date(start);
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min} мин ${sec} с`;
}

$('dcb-persona-photo').addEventListener('change', () => act(async () => {
  const file = $('dcb-persona-photo').files?.[0];
  if (!file) return;
  pendingPhoto = await fileToPhotoDataUrl(file);
  setPhotoPreview(pendingPhoto);
  showStatus('Фото сжато и готово к сохранению вместе с Си.');
}));

$('dcb-persona-photo-clear').addEventListener('click', () => {
  pendingPhoto = null;
  $('dcb-persona-photo').value = '';
  setPhotoPreview(null);
});

$('dcb-persona-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act(async () => {
    const id = $('dcb-persona-id').value;
    const body = { title: $('dcb-persona-title').value, secretBio: $('dcb-persona-bio').value };
    if (pendingPhoto !== undefined) body.photoData = pendingPhoto;
    if (id) await api.dcbPatchPersona(auth.token, id, body);
    else await api.dcbCreatePersona(auth.token, body);
    $('dcb-persona-form').reset();
    $('dcb-persona-id').value = '';
    $('dcb-persona-reset').hidden = true;
    resetPhotoForm();
    await refreshPersonas();
    showStatus('Си сохранён.');
  });
});

$('dcb-persona-reset').addEventListener('click', () => {
  $('dcb-persona-form').reset();
  $('dcb-persona-id').value = '';
  $('dcb-persona-reset').hidden = true;
  resetPhotoForm();
});

async function onePair() {
  showStatus('Би думает…');
  const bi = await api.dcbBi(auth.token, current.id);
  showSession(bi.session);
  showStatus('Си отвечает…');
  const si = await api.dcbSi(auth.token, current.id);
  showSession(si.session);
  return si;
}

// Runs SEGMENT_PAIRS exchanges, then pauses so Di can read the dialogue.
// On mid-segment failure: pause and report how many pairs completed (do not silently stop at 1).
async function runSegment({ resumeIfPaused = true } = {}) {
  if (!current) return;
  if (current.status === 'paused' && resumeIfPaused) {
    showSession((await api.dcbResume(auth.token, current.id)).session);
  }
  if (current.status !== 'running') throw new Error('Сеанс не идёт. Продолжите или начните новый.');
  let completed = 0;
  try {
    for (let i = 1; i <= SEGMENT_PAIRS; i++) {
      showStatus(`Отрезок: пара ${i} из ${SEGMENT_PAIRS}…`);
      await onePair();
      completed = i;
    }
  } catch (error) {
    try {
      if (current?.id && current.status === 'running') {
        showSession((await api.dcbPause(auth.token, current.id)).session);
      } else if (current?.id) {
        showSession((await api.dcbGetSession(auth.token, current.id)).session);
      }
    } catch {
      /* keep last shown session */
    }
    $('dcb-log').scrollIntoView({ block: 'start', behavior: 'smooth' });
    const detail = error?.message || 'Ошибка.';
    throw new Error(
      completed
        ? `Остановились после ${completed} пар из ${SEGMENT_PAIRS}: ${detail}`
        : `Не удалось сделать первую пару: ${detail}`,
    );
  }
  showSession((await api.dcbPause(auth.token, current.id)).session);
  $('dcb-log').scrollIntoView({ block: 'start', behavior: 'smooth' });
  showStatus(`Отрезок из ${SEGMENT_PAIRS} пар закончен. Ниже — диалог. Можно запустить ещё ${SEGMENT_PAIRS} пар или завершить сеанс.`);
}

$('dcb-start-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act(async () => {
    const { session } = await api.dcbCreateSession(auth.token, {
      personaId: $('dcb-start-persona').value,
      mode: $('dcb-start-mode').value,
    });
    showSession(session);
    await refreshSessions();
    await runSegment({ resumeIfPaused: false });
    await refreshSessions();
  });
});

$('dcb-segment').addEventListener('click', () => act(async () => {
  await runSegment();
  await refreshSessions();
}));

$('dcb-step').addEventListener('click', () => act(async () => {
  if (!current) return;
  if (current.status === 'paused') {
    showSession((await api.dcbResume(auth.token, current.id)).session);
  }
  const si = await onePair();
  showStatus(si.savedFacts?.length ? `Одна пара сделана. Новых фактов Си: ${si.savedFacts.length}.` : 'Одна пара сделана.');
}));

$('dcb-pause').addEventListener('click', () => act(async () => {
  showSession((await api.dcbPause(auth.token, current.id)).session);
  showStatus('Пауза.');
}));

$('dcb-resume').addEventListener('click', () => act(async () => {
  showSession((await api.dcbResume(auth.token, current.id)).session);
  showStatus('Сеанс продолжен.');
}));

$('dcb-promote').addEventListener('click', () => act(async () => {
  if (!window.confirm('Перевести сеанс в большой режим? История сохранится.')) return;
  showSession((await api.dcbPromote(auth.token, current.id)).session);
  showStatus('Режим: большой.');
}));

$('dcb-finish').addEventListener('click', () => act(async () => {
  if (!window.confirm('Завершить сеанс?')) return;
  showSession((await api.dcbFinish(auth.token, current.id)).session);
  await refreshSessions();
  showStatus('Сеанс завершён. Заполните оценку и идеи.');
}));

$('dcb-review-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act(async () => {
    const { session } = await api.dcbReview(auth.token, current.id, {
      score: Number($('dcb-score').value),
      good: $('dcb-good').value,
      mistakes: $('dcb-mistakes').value,
      missed: $('dcb-missed').value,
      comment: $('dcb-comment').value,
    });
    showSession(session);
    showStatus('Оценка сохранена.');
  });
});

$('dcb-ideas-form').addEventListener('submit', (event) => {
  event.preventDefault();
  act(async () => {
    const { session } = await api.dcbIdeas(auth.token, current.id, {
      strategy: $('dcb-idea-strategy').value,
      acquaintance: $('dcb-idea-acquaintance').value,
      siNotes: $('dcb-idea-si').value,
      nextTrials: $('dcb-idea-next').value,
    });
    showSession(session);
    showStatus('Идеи сохранены.');
  });
});

$('dcb-export').addEventListener('click', () => act(async () => {
  const data = await api.dcbExport(auth.token, current.id);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `dcb-session-${current.id.slice(0, 8)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  showStatus('Экспорт сохранён.');
}));

if (!api.configured) {
  showStatus('Сервер Buddy не подключён.');
} else {
  await act(async () => {
    auth = await currentUser(storage);
    if (!auth?.user.admin) {
      $('dcb-signed-out').hidden = false;
      return;
    }
    $('dcb-app').hidden = false;
    renderBudget((await api.dcbBudget(auth.token)).budget);
    await refreshPersonas();
    await refreshSessions();
  });
}
