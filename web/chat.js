import { VOICE_SAMPLE, prompts, normalizeName, pickVoices, findVoice, opening, afterVoiceChoice, afterName } from './dialogue.js';
import { openStorage } from './storage.js';
import { speechSupported, loadVoices, unlockSpeech, speak, stopSpeaking } from './speech.js';

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

  let storage = null;
  let profile = null;
  let voices = [];
  let mode = null;
  let currentVoice = null;
  let started = false;
  let submitting = false;

  function setStep(step) {
    voicesPanel.hidden = step !== 'chooseVoice';
    nameForm.hidden = step !== 'askName';
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

  async function biSay(messages) {
    for (const text of messages) {
      appendMessage('bi', text);
      await storage.addMessage('bi', text);
    }
    if (mode === 'voice') speak(messages.join(' '), currentVoice);
  }

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
    await updateProfile({ mode: 'voice', voice: { uri: voice.voiceURI, name: voice.name, lang: voice.lang } });
    await userSay(`Голос: ${voice.name}`);
    const reply = afterVoiceChoice({ profile, mode });
    await biSay(reply.messages);
    setStep(reply.step);
  }

  async function chooseTextMode() {
    stopSpeaking();
    mode = 'text';
    currentVoice = null;
    refreshReplayButtons();
    await updateProfile({ mode: 'text', voice: null });
    await userSay('Без голоса, только текст');
    const reply = afterVoiceChoice({ profile, mode });
    await biSay(reply.messages);
    setStep(reply.step);
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
    await biSay(reply.messages);
    setStep(reply.step);
    navigator.storage?.persist?.().catch(() => {});
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
    await biSay(messages);
    setStep(result.step);
    if (profile) await updateProfile({ lastVisitAt: new Date().toISOString() });
  }

  async function changeVoice() {
    menu.open = false;
    if (!voices.length) {
      await biSay([prompts.noVoicesHere]);
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
