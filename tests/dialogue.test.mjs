import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { normalizeName, pickVoices, findVoice, opening, afterVoiceChoice, afterName, MAX_NAME_LENGTH, micDecision, micErrorReply, prompts } from '../web/dialogue.js';

test('микрофон: без поддержки кнопки нет, без разрешения Би спрашивает, с разрешением слушает', () => {
  assert.equal(micDecision({ supported: false, permission: { granted: true } }), 'unsupported');
  assert.equal(micDecision({ supported: true, permission: null }), 'ask');
  assert.equal(micDecision({ supported: true, permission: { granted: false } }), 'ask', 'отозванное разрешение — снова спросить');
  assert.equal(micDecision({ supported: true, permission: { granted: true, at: 'T' } }), 'listen');
});

test('Би честно говорит, куда уходит звук, и что отправляет человек', () => {
  assert.match(prompts.askMicrophone, /Google или Apple/);
  assert.match(prompts.askMicrophone, /не разработчику/);
  assert.match(prompts.askMicrophone, /только когда ты нажимаешь 🎤/);
  assert.equal(micErrorReply('not-allowed'), prompts.micBlocked);
  assert.equal(micErrorReply('network'), prompts.micUnavailable);
});

const ru1 = { name: 'Milena', voiceURI: 'com.apple.voice.Milena', lang: 'ru-RU' };
const ru2 = { name: 'Google русский', voiceURI: 'Google русский', lang: 'ru-RU' };
const ru3 = { name: 'Irina', voiceURI: 'irina', lang: 'ru_RU' };
const en = { name: 'Samantha', voiceURI: 'samantha', lang: 'en-US' };

test('первая встреча начинается с инициативы Би и выбора голоса', () => {
  const result = opening({ profile: null, speechSupported: true, voices: [ru1] });
  assert.deepEqual(result.messages, ['Привет! Я Би. Сначала выбери, каким голосом мне говорить.']);
  assert.equal(result.step, 'chooseVoice');
  assert.equal(result.mode, null);
});

test('после выбора голоса Би спрашивает имя', () => {
  const result = afterVoiceChoice({ profile: { mode: 'voice' }, mode: 'voice' });
  assert.deepEqual(result.messages, ['Вот теперь можем познакомиться. А как мне тебя называть?']);
  assert.equal(result.step, 'askName');
});

test('без синтеза речи сразу текстовый режим', () => {
  const result = opening({ profile: null, speechSupported: false, voices: [] });
  assert.equal(result.mode, 'text');
  assert.equal(result.step, 'askName');
  assert.match(result.messages[0], /не могу говорить вслух/);
});

test('без русского голоса текстовый режим', () => {
  const result = opening({ profile: null, speechSupported: true, voices: [] });
  assert.equal(result.mode, 'text');
  assert.equal(result.step, 'askName');
  assert.match(result.messages[0], /нет русского голоса/);
});

test('при следующем запуске Би узнаёт человека и говорит сохранённым голосом', () => {
  const profile = { name: 'Аня', mode: 'voice', voice: { uri: ru1.voiceURI, name: ru1.name, lang: ru1.lang } };
  const result = opening({ profile, speechSupported: true, voices: [ru2, ru1] });
  assert.deepEqual(result.messages, ['Привет, Аня! Рад снова тебя видеть.']);
  assert.equal(result.step, 'idle');
  assert.equal(result.mode, 'voice');
  assert.equal(findVoice([ru2, ru1], profile.voice), ru1);
});

test('если сохранённого голоса на устройстве нет, Би просит выбрать другой', () => {
  const profile = { name: 'Аня', mode: 'voice', voice: { uri: 'gone', name: 'Gone', lang: 'ru-RU' } };
  const result = opening({ profile, speechSupported: true, voices: [ru2] });
  assert.equal(result.step, 'chooseVoice');
  assert.match(result.messages[0], /Привет, Аня!.*Выбери другой/);
});

test('если текст был вынужденным, а голос появился, Би сам предлагает выбрать голос', () => {
  const profile = { name: 'Аня', mode: 'text', voice: null };
  const result = opening({ profile, speechSupported: true, voices: [ru1] });
  assert.equal(result.step, 'chooseVoice');
  assert.match(result.messages[0], /Теперь у меня есть русский голос/);
  assert.equal(opening({ profile, speechSupported: true, voices: [] }).step, 'idle');
});

test('если человек сам выбрал «только текст», Би не навязывает голос', () => {
  const profile = { name: 'Аня', mode: 'text', voice: null, voiceDeclined: true };
  const result = opening({ profile, speechSupported: true, voices: [ru1] });
  assert.equal(result.step, 'idle');
  assert.deepEqual(result.messages, ['Привет, Аня! Рад снова тебя видеть.']);
});

test('если голос выбран, но имя не названо, Би возвращается к имени', () => {
  const result = opening({ profile: { mode: 'voice', voice: { uri: ru1.voiceURI } }, speechSupported: true, voices: [ru1] });
  assert.equal(result.step, 'askName');
});

test('знакомство завершается обещанием узнать, смена имени — подтверждением', () => {
  assert.match(afterName({ previousName: null, name: 'Аня', mode: 'voice' }).messages[0], /Приятно познакомиться, Аня! .*каким голосом/);
  assert.doesNotMatch(afterName({ previousName: null, name: 'Аня', mode: 'text' }).messages[0], /голосом/);
  assert.deepEqual(afterName({ previousName: 'Аня', name: 'Анна', mode: 'text' }).messages, ['Хорошо, теперь буду звать тебя Анна.']);
});

test('смена голоса знакомым человеком не повторяет вопрос об имени', () => {
  assert.equal(afterVoiceChoice({ profile: { name: 'Аня' }, mode: 'voice' }).step, 'idle');
  assert.equal(afterVoiceChoice({ profile: { name: 'Аня' }, mode: 'text' }).step, 'idle');
});

test('имя очищается и проверяется', () => {
  assert.deepEqual(normalizeName('  Аня \n Петрова '), { ok: true, name: 'Аня Петрова' });
  assert.deepEqual(normalizeName('Ан\u0000я\u200b'), { ok: true, name: 'Аня' });
  assert.equal(normalizeName('   ').ok, false);
  assert.equal(normalizeName('я'.repeat(MAX_NAME_LENGTH + 1)).ok, false);
  assert.equal(normalizeName('я'.repeat(MAX_NAME_LENGTH)).ok, true);
});

test('в списке голосов только русские, без повторов, по алфавиту', () => {
  const picked = pickVoices([en, ru2, ru1, ru3, { ...ru1 }]);
  assert.deepEqual(picked.map((v) => v.name), ['Google русский', 'Irina', 'Milena']);
  assert.equal(pickVoices(Array.from({ length: 20 }, (_, i) => ({ name: `v${i}`, voiceURI: `v${i}`, lang: 'ru-RU' }))).length, 8);
});

test('Би обращается на «ты»', async () => {
  const source = await readFile(new URL('../web/dialogue.js', import.meta.url), 'utf8');
  const lines = [...source.matchAll(/'([^']*[А-Яа-яЁё][^']*)'|`([^`]*[А-Яа-яЁё][^`]*)`/g)].map((m) => m[1] ?? m[2]);
  assert.ok(lines.length > 10);
  for (const line of lines) assert.doesNotMatch(line, /(^|[^А-Яа-яЁё])(вы|вас|вам|ваш\p{L}*)([^А-Яа-яЁё]|$)/iu, line);
});
