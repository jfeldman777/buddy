import { VOICE_SAMPLE, prompts, normalizeName, pickVoices, findVoice, opening, afterVoiceChoice, afterName, explainAct } from './dialogue.js';
import { buildEntry, normalizeRating, answerLabels, RATING_QUESTION } from './journal.js';
import { openStorage } from './storage.js';
import { speechSupported, loadVoices, unlockSpeech, speak, stopSpeaking } from './speech.js';
import { detectPlatform } from './pwa.js';

const HISTORY_LIMIT = 20;

export function initChat({ onProfileChange }) {
  const section = document.getElementById('chat');
  const log = document.getElementById('chat-log');
  const voicesPanel = document.getElementById('chat-voices');
  const voiceList = document.getElementById('chat-voice-list');
  const textModeButton = document.getElementById('chat-text-mode');
  const nameForm = document.getElementById('chat-name-form');
  const nameInput = document.getElementById('chat-name');
  const idleNote = document.getElementById('chat-idle');
  const menu = document.getElementById('chat-menu');
  const voiceHelp = document.getElementById('chat-voice-help');
  const ratingPanel = document.getElementById('chat-rating');

  const platform = detectPlatform();
  const helpPlatform = platform === 'desktop' ? (/Macintosh/.test(navigator.userAgent) ? 'mac' : 'windows') : platform;
  voiceHelp.querySelector(`details[data-platform="${helpPlatform}"]`)?.setAttribute('open', '');

  let storage = null;
  let profile = null;
  let voices = [];
  let mode = null;
  let currentVoice = null;
  let started = false;
  let submitting = false;
  let ratingEventId = null;

  function showVoiceHelpIfNeeded() {
    voiceHelp.hidden = !(speechSupported() && voices.length === 0);
    return !voiceHelp.hidden;
  }

  async function record(kind, ctx, facts, result) {
    const { title, explanation } = explainAct(kind, ctx);
    const entry = buildEntry({ kind, title, explanation, facts, result });
    try {
      await storage.addJournalEntry(entry);
    } catch (error) {
      console.warn('Запись в журнал не удалась:', error);
    }
    return entry.event.eventId;
  }

  function setStep(step) {
    voicesPanel.hidden = step !== 'chooseVoice';
    nameForm.hidden = step !== 'askName';
    ratingPanel.hidden = step !== 'rate';
    idleNote.hidden = step !== 'idle';
    if (step === 'chooseVoice') renderVoices();
    if (step === 'askName') {
      nameInput.value = '';
      nameInput.focus();
    }
  }

  function appendMessage(role, text, { earlier = false } = {}) {
    const item = document.createElement('li');
    item.className = `msg msg-${role}${earlier ? ' msg-earlier' : ''}`;
    const body = document.createElement('span');
    body.textContent = text;
    item.append(body);
    if (role === 'bi' && !earlier) {
      const replay = document.createElement('button');
      replay.type = 'button';
      replay.className = 'msg-replay';
      replay.textContent = '🔊';
      replay.setAttribute('aria-label', 'Повторить вслух');
      replay.hidden = mode !== 'voice';
      replay.addEventListener('click', () => speak(text, currentVoice));
      item.append(replay);
    }
    log.append(item);
    item.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function refreshReplayButtons() {
    for (const button of log.querySelectorAll('.msg-replay')) button.hidden = mode !== 'voice';
  }

  // Returns the program fact about speech, or null when Bi only wrote.
  async function biSay(messages) {
    for (const text of messages) {
      appendMessage('bi', text);
      await storage.addMessage('bi', text);
    }
    if (mode !== 'voice' || !currentVoice) return null;
    speak(messages.join(' '), currentVoice);
    return { type: 'speech_requested', voice: currentVoice.name };
  }

  const withSpeech = (facts, speech) => (speech ? [...facts, speech] : facts);

  async function userSay(text) {
    appendMessage('user', text);
    await storage.addMessage('user', text);
  }

  async function updateProfile(patch) {
    profile = await storage.saveProfile(patch);
    onProfileChange?.(profile);
  }

  function renderVoices() {
    voiceList.replaceChildren(...voices.map((voice) => {
      const item = document.createElement('li');
      const label = document.createElement('span');
      label.className = 'voice-name';
      label.textContent = voice.name;
      const listen = document.createElement('button');
      listen.type = 'button';
      listen.className = 'btn btn-secondary btn-small';
      listen.textContent = 'Послушать';
      listen.addEventListener('click', () => speak(VOICE_SAMPLE, voice));
      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'btn btn-primary btn-small';
      choose.textContent = 'Выбрать';
      choose.addEventListener('click', () => chooseVoice(voice));
      item.append(label, listen, choose);
      return item;
    }));
  }

  async function chooseVoice(voice) {
    mode = 'voice';
    currentVoice = voice;
    refreshReplayButtons();
    await updateProfile({ mode: 'voice', voice: { uri: voice.voiceURI, name: voice.name, lang: voice.lang }, voiceDeclined: false });
    await userSay(`Голос: ${voice.name}`);
    const reply = afterVoiceChoice({ profile, mode });
    const speech = await biSay(reply.messages);
    setStep(reply.step);
    await record('voice_chosen', { voiceName: voice.name },
      withSpeech([{ type: 'saved_on_device', what: 'голос', value: voice.name }], speech),
      'Голос сохранён на этом устройстве.');
  }

  async function chooseTextMode() {
    stopSpeaking();
    mode = 'text';
    currentVoice = null;
    refreshReplayButtons();
    await updateProfile({ mode: 'text', voice: null, voiceDeclined: true });
    await userSay('Без голоса, только текст');
    const reply = afterVoiceChoice({ profile, mode });
    await biSay(reply.messages);
    setStep(reply.step);
    await record('text_chosen', {},
      [{ type: 'saved_on_device', what: 'режим', value: 'только текст' }],
      'Би только пишет и сам голос не предлагает.');
  }

  async function submitName(event) {
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    try {
      await handleName(nameInput.value);
    } finally {
      submitting = false;
    }
  }

  async function handleName(raw) {
    const result = normalizeName(raw);
    if (!result.ok) {
      if (raw.trim()) await userSay(raw.trim());
      await biSay([result.reply]);
      nameInput.focus();
      return;
    }
    const previousName = profile?.name ?? null;
    await updateProfile({ name: result.name, mode });
    await userSay(result.name);
    const reply = afterName({ previousName, name: result.name, mode });
    const speech = await biSay(reply.messages);
    setStep(reply.step);
    navigator.storage?.persist?.().catch(() => {});
    const facts = withSpeech([{ type: 'saved_on_device', what: 'имя', value: result.name }], speech);
    if (previousName) {
      await record('name_changed', { previousName, name: result.name }, facts, 'Новое имя сохранено на этом устройстве.');
      return;
    }
    const eventId = await record('name_remembered', { name: result.name }, facts, 'Имя сохранено на этом устройстве.');
    await askRating(eventId);
  }

  // Asked once, after the acquaintance, not after every line (spec, section 9).
  async function askRating(eventId) {
    ratingEventId = eventId;
    await biSay([RATING_QUESTION]);
    setStep('rate');
  }

  async function rate(answer) {
    if (!ratingEventId) return;
    const result = normalizeRating({ answer });
    if (!result.ok) return;
    const eventId = ratingEventId;
    ratingEventId = null;
    await storage.rateEvent(eventId, result.rating);
    await userSay(answerLabels[answer]);
    await biSay([prompts.thanksForRating]);
    setStep('idle');
  }

  async function start() {
    storage = await openStorage();
    const supported = speechSupported();
    voices = pickVoices(supported ? await loadVoices() : []);
    profile = await storage.getProfile();

    const history = await storage.recentMessages(HISTORY_LIMIT);
    for (const message of history) appendMessage(message.role, message.text, { earlier: true });

    const result = opening({ profile, speechSupported: supported, voices });
    mode = result.mode;
    currentVoice = mode === 'voice' ? findVoice(voices, profile?.voice) : null;

    const messages = [...result.messages];
    if (!storage.persistent) messages.push('Похоже, браузер не даёт мне ничего запоминать — например, в приватном режиме. В следующий раз я тебя не узнаю.');
    const speech = await biSay(messages);
    setStep(result.step);
    const helpShown = showVoiceHelpIfNeeded();
    if (profile) await updateProfile({ lastVisitAt: new Date().toISOString() });
    if (result.act) await recordOpening(result, speech, helpShown);
  }

  async function recordOpening({ act, step }, speech, helpShown) {
    const savedVoice = profile?.voice?.name;
    const remembered = { type: 'read_on_device', what: savedVoice ? 'имя и голос' : 'имя' };
    const help = helpShown ? [{ type: 'shown_help', topic: 'как добавить русский голос' }] : [];
    switch (act) {
      case 'recognized':
        await record(act, { name: profile.name, voiceName: currentVoice?.name }, withSpeech([remembered], speech), 'Би поздоровался по имени.');
        break;
      case 'text_forced':
        await record(act, { speechSupported: speechSupported() }, help, 'Знакомство продолжается перепиской.');
        break;
      case 'voice_missing': {
        const offer = step === 'chooseVoice' ? [{ type: 'shown_offer', offer: 'выбрать другой голос' }] : [];
        await record(act, { voiceName: savedVoice, canSpeak: voices.length > 0 }, [remembered, ...offer, ...help],
          step === 'chooseVoice' ? 'Ждёт выбора другого голоса.' : 'Би пишет текстом.');
        break;
      }
      case 'voice_offered':
        await record(act, { name: profile.name }, [remembered, { type: 'shown_offer', offer: 'выбрать голос или остаться в переписке' }], 'Ждёт выбора.');
        break;
    }
  }

  async function recheckVoices() {
    voices = pickVoices(await loadVoices());
    showVoiceHelpIfNeeded();
    if (voices.length) {
      await biSay([prompts.voiceFound]);
      setStep('chooseVoice');
      await record('voice_found', {}, [{ type: 'shown_offer', offer: 'выбрать голос' }], `Найдено русских голосов: ${voices.length}.`);
    } else {
      await biSay([prompts.voiceStillMissing]);
    }
  }

  async function changeVoice() {
    menu.open = false;
    if (!voices.length) {
      await biSay([prompts.noVoicesHere]);
      showVoiceHelpIfNeeded();
      return;
    }
    await biSay([prompts.changeVoice]);
    setStep('chooseVoice');
  }

  async function changeName() {
    menu.open = false;
    await biSay([prompts.changeName]);
    setStep('askName');
  }

  async function forget() {
    menu.open = false;
    if (!window.confirm('Удалить с этого устройства имя, выбор голоса и историю разговора с Би?')) return;
    stopSpeaking();
    await storage.deleteAll();
    profile = null;
    mode = null;
    currentVoice = null;
    ratingEventId = null;
    started = false;
    log.replaceChildren();
    onProfileChange?.(null);
    close();
  }

  function show(visible) {
    document.body.classList.toggle('chat-open', visible);
    section.hidden = !visible;
  }

  async function open({ fromGesture = false } = {}) {
    if (fromGesture) unlockSpeech();
    show(true);
    window.scrollTo(0, 0);
    if (location.hash !== '#bi') history.pushState({ chat: true }, '', '#bi');
    if (!started) {
      started = true;
      await start();
    }
  }

  function close() {
    stopSpeaking();
    show(false);
    if (location.hash === '#bi') history.replaceState(null, '', location.pathname + location.search);
  }

  textModeButton.addEventListener('click', chooseTextMode);
  document.getElementById('chat-voice-recheck').addEventListener('click', recheckVoices);
  for (const button of ratingPanel.querySelectorAll('button[data-answer]')) {
    button.addEventListener('click', () => rate(button.dataset.answer));
  }
  nameForm.addEventListener('submit', submitName);
  document.getElementById('chat-back').addEventListener('click', () => (history.state?.chat ? history.back() : close()));
  document.getElementById('chat-change-voice').addEventListener('click', changeVoice);
  document.getElementById('chat-change-name').addEventListener('click', changeName);
  document.getElementById('chat-forget').addEventListener('click', forget);
  window.addEventListener('popstate', () => {
    if (location.hash === '#bi') open();
    else if (!section.hidden) close();
  });

  return { open, close };
}
