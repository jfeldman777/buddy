import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  buildEntry, checkCompliance, normalizeRating, describeFact, joinEntries, exportJournal, exportFileName,
  DECLARATION_IDS, MAX_COMMENT_LENGTH, RATING_QUESTION, EXPORT_FORMAT,
} from '../web/journal.js';
import { explainAct, opening } from '../web/dialogue.js';

const statusOf = (results, id) => results.find((r) => r.id === id);

test('запись журнала состоит из четырёх раздельных частей с общим eventId', () => {
  const { title, explanation } = explainAct('name_remembered', { name: 'Аня' });
  const entry = buildEntry({ kind: 'name_remembered', title, explanation, facts: [{ type: 'saved_on_device', what: 'имя', value: 'Аня' }], result: 'Сохранено.', eventId: 'e1', at: '2026-10-15T08:00:00.000Z' });
  assert.deepEqual(entry.event, { eventId: 'e1', at: '2026-10-15T08:00:00.000Z', kind: 'name_remembered', title: 'Би запомнил имя' });
  for (const part of ['explanation', 'actions', 'compliance']) assert.equal(entry[part].eventId, 'e1');
  assert.equal(entry.rating, undefined, 'оценку ставит человек, а не программа при записи');
  assert.match(entry.explanation.motive, /Обещал узнавать/);
  assert.deepEqual(entry.actions.facts, [{ type: 'saved_on_device', what: 'имя', value: 'Аня' }]);
});

test('фактические действия берутся только от программы, а не из объяснения Би', () => {
  const explanation = { situation: 'x', decision: 'Отправил данные разработчику', declarations: ['D2'], facts: [{ type: 'data_sent' }] };
  const entry = buildEntry({ kind: 'k', title: 't', explanation, facts: [] });
  assert.deepEqual(entry.actions.facts, []);
});

test('без событий D1 и D2 проверяет программа: соблюдено', () => {
  const results = checkCompliance({ declarations: ['D3'] }, { facts: [] });
  assert.deepEqual(results.map((r) => r.id), DECLARATION_IDS);
  for (const id of ['D1', 'D2']) {
    assert.equal(statusOf(results, id).status, 'kept');
    assert.equal(statusOf(results, id).checkedBy, 'program');
  }
});

test('декларации, на которые ссылается Би, помечаются «не проверено», остальные — «не применимо»', () => {
  const results = checkCompliance({ declarations: ['D3', 'D7'] }, { facts: [] });
  assert.equal(statusOf(results, 'D3').status, 'unchecked');
  assert.equal(statusOf(results, 'D7').status, 'unchecked');
  assert.equal(statusOf(results, 'D3').checkedBy, 'none');
  for (const id of ['D4', 'D5', 'D6']) assert.equal(statusOf(results, id).status, 'not_applicable');
});

test('D2: передача без согласия — нарушение, с согласием — соблюдено', () => {
  assert.equal(statusOf(checkCompliance({}, { facts: [{ type: 'data_sent', what: 'запись журнала', consent: false }] }), 'D2').status, 'violated');
  assert.equal(statusOf(checkCompliance({}, { facts: [{ type: 'data_sent', what: 'запись журнала', consent: true }] }), 'D2').status, 'kept');
});

test('D1: микрофон без разрешения — нарушение, после разрешения — соблюдено', () => {
  assert.equal(statusOf(checkCompliance({}, { facts: [{ type: 'device_used', device: 'microphone' }] }), 'D1').status, 'violated');
  const allowed = { facts: [{ type: 'permission_granted', device: 'microphone' }, { type: 'device_used', device: 'microphone' }] };
  assert.equal(statusOf(checkCompliance({}, allowed), 'D1').status, 'kept');
});

test('расхождение объяснения Би с действиями программы — нарушение', () => {
  const explanation = { claims: { sentData: false, usedDevices: false } };
  const sent = { facts: [{ type: 'data_sent', what: 'запись журнала', consent: true }] };
  const d2 = statusOf(checkCompliance(explanation, sent), 'D2');
  assert.equal(d2.status, 'violated');
  assert.match(d2.basis, /расходится/);
  const used = { facts: [{ type: 'permission_granted', device: 'camera' }, { type: 'device_used', device: 'camera' }] };
  assert.equal(statusOf(checkCompliance(explanation, used), 'D1').status, 'violated');
});

test('самооценка Би помечается как самооценка, а не программная проверка', () => {
  const results = checkCompliance({ declarations: ['D4'], selfAssessment: { D4: { status: 'kept' }, D1: { status: 'kept' } } }, { facts: [{ type: 'device_used', device: 'camera' }] });
  assert.equal(statusOf(results, 'D4').checkedBy, 'self');
  assert.equal(statusOf(results, 'D1').checkedBy, 'program', 'самооценка не подменяет программную проверку');
  assert.equal(statusOf(results, 'D1').status, 'violated');
});

test('оценка: только «Да», «Нет», «Не знаю»; комментарий ограничен и очищен', () => {
  assert.equal(RATING_QUESTION, 'Это было кстати?');
  assert.equal(normalizeRating({ answer: 'maybe' }).ok, false);
  const ok = normalizeRating({ answer: 'no', comment: '  слишком\u200b рано \n ' }, 'T');
  assert.deepEqual(ok, { ok: true, rating: { answer: 'no', comment: 'слишком рано', at: 'T' } });
  assert.equal(normalizeRating({ answer: 'yes', comment: 'я'.repeat(MAX_COMMENT_LENGTH + 1) }).ok, false);
});

test('описание фактов понятно человеку', () => {
  assert.equal(describeFact({ type: 'saved_on_device', what: 'имя', value: 'Аня' }), 'Сохранено на этом устройстве: имя — «Аня».');
  assert.equal(describeFact({ type: 'data_sent', what: 'запись журнала', consent: false }), 'Отправлено разработчику: запись журнала (без согласия).');
  assert.match(describeFact({ type: 'something_new' }), /something_new/);
});

test('журнал собирается из частей, новые записи сверху, оценка приклеивается по eventId', () => {
  const parts = {
    events: [{ eventId: 'a', at: '2026-10-15T08:00:00Z', kind: 'k', title: 'A' }, { eventId: 'b', at: '2026-10-15T09:00:00Z', kind: 'k', title: 'B' }],
    explanations: [{ eventId: 'a', situation: 'sa' }, { eventId: 'b', situation: 'sb' }],
    actions: [{ eventId: 'a', facts: [] }, { eventId: 'b', facts: [] }],
    compliance: [{ eventId: 'a', results: [] }, { eventId: 'b', results: [] }],
    ratings: [{ eventId: 'a', answer: 'yes', comment: '', at: 'T' }],
  };
  const entries = joinEntries(parts);
  assert.deepEqual(entries.map((e) => e.eventId), ['b', 'a']);
  assert.equal(entries[1].rating.answer, 'yes');
  assert.equal(entries[0].rating, null);
});

test('экспорт: формат, версия деклараций, все четыре части', () => {
  const { title, explanation } = explainAct('voice_chosen', { voiceName: 'Milena' });
  const entry = buildEntry({ kind: 'voice_chosen', title, explanation, facts: [], eventId: 'e1', at: 'T' });
  const [joined] = joinEntries({ events: [entry.event], explanations: [entry.explanation], actions: [entry.actions], compliance: [entry.compliance], ratings: [{ eventId: 'e1', answer: 'unsure', comment: '', at: 'T2' }] });
  const data = exportJournal([joined], { declarationsVersion: 1, exportedAt: 'NOW' });
  assert.equal(data.format, EXPORT_FORMAT);
  assert.equal(data.declarationsVersion, 1);
  assert.equal(data.exportedAt, 'NOW');
  const [item] = data.entries;
  assert.equal(item.eventId, 'e1');
  for (const part of ['explanation', 'actions', 'compliance', 'rating']) assert.ok(item[part], `нет части ${part}`);
  assert.equal(item.rating.answer, 'unsure');
  assert.equal(exportFileName(new Date('2026-10-15T12:00:00Z')), 'buddy-journal-2026-10-15.json');
});

test('у каждого поступка из сценария есть объяснение со всеми полями и только декларации D1–D7', async () => {
  const declarations = JSON.parse(await readFile(new URL('../web/declarations.json', import.meta.url), 'utf8')).declarations.map((d) => d.id);
  const kinds = ['recognized', 'text_forced', 'voice_missing', 'voice_offered', 'voice_found', 'voice_chosen', 'text_chosen', 'name_remembered', 'name_changed'];
  for (const kind of kinds) {
    const { title, explanation } = explainAct(kind, { name: 'Аня', previousName: 'Ann', voiceName: 'Milena', canSpeak: true, speechSupported: true });
    assert.ok(title, kind);
    for (const field of ['situation', 'goal', 'decision', 'motive']) assert.ok(explanation[field], `${kind}: нет поля ${field}`);
    assert.ok(explanation.declarations.length > 0, `${kind}: нет деклараций`);
    for (const id of explanation.declarations) assert.ok(declarations.includes(id), `${kind}: неизвестная декларация ${id}`);
    assert.equal(explanation.source, 'script');
    assert.deepEqual(explanation.claims, { sentData: false, usedDevices: false });
    assert.doesNotMatch(Object.values(explanation).join(' '), /undefined/, `${kind}: в тексте undefined`);
  }
  assert.throws(() => explainAct('unknown'));
});

test('opening сообщает, какой поступок записать в журнал', () => {
  const ru = { name: 'Milena', voiceURI: 'm', lang: 'ru-RU' };
  assert.equal(opening({ profile: null, speechSupported: true, voices: [ru] }).act, null, 'приветствие — не поступок');
  assert.equal(opening({ profile: null, speechSupported: true, voices: [] }).act, 'text_forced');
  assert.equal(opening({ profile: null, speechSupported: false, voices: [] }).act, 'text_forced');
  assert.equal(opening({ profile: { name: 'Аня', mode: 'voice', voice: { uri: 'm', name: 'Milena' } }, speechSupported: true, voices: [ru] }).act, 'recognized');
  assert.equal(opening({ profile: { name: 'Аня', mode: 'voice', voice: { uri: 'x', name: 'X' } }, speechSupported: true, voices: [ru] }).act, 'voice_missing');
  assert.equal(opening({ profile: { name: 'Аня', mode: 'text' }, speechSupported: true, voices: [ru] }).act, 'voice_offered');
});
