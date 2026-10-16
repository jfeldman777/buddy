import { VOICE_SAMPLE, prompts, normalizeName, pickVoices, findVoice, opening, afterVoiceChoice, afterName, explainAct, micDecision, micErrorReply } from './dialogue.js';
import { recognitionSupported, listenOnce } from './listen.js';
import { buildEntry, normalizeRating, answerLabels, RATING_QUESTION } from './journal.js';
import { openStorage } from './storage.js';
import { speechSupported, loadVoices, unlockSpeech, speak, stopSpeaking } from './speech.js';
import { detectPlatform } from './pwa.js';
import { api, ApiError } from './api.js';
import { currentUser } from './account.js';
import { fileToPhotoDataUrl } from './photo.js';

const HISTORY_LIMIT = 20;
const TRANSCRIPT_SEND_MAX = 60;

function localDayStartIso() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export function initChat({ onProfileChange }) {
  const section = document.getElementById('chat');
  const log = document.getElementById('chat-log');
  const voicesPanel = document.getElementById('chat-voices');
  const voiceList = document.getElementById('chat-voice-list');
  const textModeButton = document.getElementById('chat-text-mode');
  const nameForm = document.getElementById('chat-name-form');
  const nameInput = document.getElementById('chat-name');
  const idleNote = document.getElementById('chat-idle');
  const talkForm = document.getElementById('chat-talk-form');
  const talkInput = document.getElementById('chat-talk-input');
  const talkStatus = document.getElementById('chat-talk-status');
  const authNeeded = document.getElementById('chat-auth-needed');
  const consentPanel = document.getElementById('chat-consent-panel');
  const consentText = document.getElementById('chat-consent-text');
  const consentAccept = document.getElementById('chat-consent-accept');
  const startAi = document.getElementById('chat-start-ai');
  const budgetNote = document.getElementById('chat-budget-note');
  const photoFile = document.getElementById('chat-photo-file');
  const photoCamera = document.getElementById('chat-photo-camera');
  const photoPreviewWrap = document.getElementById('chat-photo-preview-wrap');
  const photoPreview = document.getElementById('chat-photo-preview');
  const photoClear = document.getElementById('chat-photo-clear');
  const cameraConsent = document.getElementById('chat-camera-consent');
  const menu = document.getElementById('chat-menu');
  const voiceHelp = document.getElementById('chat-voice-help');
  const ratingPanel = document.getElementById('chat-rating');
  const micButton = document.getElementById('chat-mic');
  const micConsent = document.getElementById('chat-mic-consent');
  const micRevoke = document.getElementById('chat-mic-revoke');
  const voiceEnabledMenu = document.getElementById('chat-voice-enabled');
  const voiceEnabledTalk = document.getElementById('chat-voice-enabled-talk');

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
  let listening = null;
  let micPermissionNow = null;
  let auth = null;
  let pendingPhoto = null;
  let talking = false;

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
    micConsent.hidden = true;
    cameraConsent.hidden = true;
    idleNote.hidden = step !== 'idle';
    talkForm.hidden = step !== 'talk';
    if (step === 'chooseVoice') renderVoices();
    if (step === 'askName') {
      nameInput.value = '';
      nameInput.focus();
    }
    if (step === 'idle') void prepareAiGate();
    if (step === 'talk') talkInput.focus();
  }

  function setTalkStatus(text) {
    talkStatus.textContent = text || '';
    talkStatus.hidden = !text;
  }

  function setPhotoPreview(dataUrl) {
    pendingPhoto = dataUrl || null;
    if (dataUrl) {
      photoPreview.src = dataUrl;
      photoPreviewWrap.hidden = false;
      photoClear.hidden = false;
    } else {
      photoPreview.removeAttribute('src');
      photoPreviewWrap.hidden = true;
      photoClear.hidden = true;
      photoFile.value = '';
      photoCamera.value = '';
    }
  }

  async function prepareAiGate() {
    startAi.hidden = true;
    consentPanel.hidden = true;
    authNeeded.hidden = true;
    budgetNote.hidden = true;
    if (!api.configured) {
      authNeeded.hidden = false;
      authNeeded.textContent = 'Сервер Buddy не подключён — разговор с ИИ недоступен.';
      return;
    }
    try {
      auth = await currentUser(storage);
    } catch {
      auth = null;
    }
    if (!auth) {
      authNeeded.hidden = false;
      return;
    }
    try {
      const { consent } = await api.chatConsent(auth.token);
      if (!consent.given) {
        consentText.textContent = consent.text;
        consentPanel.hidden = false;
        return;
      }
      const { budget } = await api.chatBudget(auth.token);
      budgetNote.textContent = `Бюджет общения с Би: осталось $${budget.remainingUsd.toFixed(4)} из $${budget.grantedUsd.toFixed(2)}.`;
      budgetNote.hidden = false;
      startAi.hidden = false;
    } catch (error) {
      authNeeded.hidden = false;
      authNeeded.textContent = error.message || 'Не удалось проверить согласие.';
    }
  }

  async function acceptConsent() {
    if (!auth) return;
    await api.chatGiveConsent(auth.token, { accept: true });
    await record('memory_consent', {}, [{ type: 'data_sent', what: 'согласие на память Би', consent: true }], 'Согласие сохранено.');
    await prepareAiGate();
  }

  async function todaysTranscript({ excludeTrailingUserText = null } = {}) {
    if (!storage?.messagesSince) return [];
    const rows = await storage.messagesSince(localDayStartIso());
    let list = rows.filter((m) => (m.role === 'user' || m.role === 'bi')
      && m.text
      && !String(m.text).startsWith('(Контекст с сервера)'));
    if (excludeTrailingUserText != null
      && list.length
      && list[list.length - 1].role === 'user'
      && list[list.length - 1].text === excludeTrailingUserText) {
      list = list.slice(0, -1);
    }
    return list.slice(-TRANSCRIPT_SEND_MAX).map((m) => ({ role: m.role, text: String(m.text).slice(0, 2000) }));
  }

  function lastBiFromTranscript(transcript) {
    for (let i = transcript.length - 1; i >= 0; i -= 1) {
      if (transcript[i].role === 'bi') return transcript[i].text;
    }
    return '';
  }

  async function beginAiTalk() {
    if (!auth || talking) return;
    talking = true;
    setTalkStatus('Би думает…');
    setStep('talk');
    try {
      const ctx = await api.chatContext(auth.token);
      if (ctx.context?.summary) {
        appendMessage('bi', `(Контекст с сервера) ${ctx.context.summary}`, { earlier: true });
      }
      const transcript = await todaysTranscript();
      const data = await api.chatTurn(auth.token, {
        open: true,
        displayName: profile?.name || '',
        transcript,
        lastBiReply: lastBiFromTranscript(transcript) || ctx.context?.lastUtterance || '',
      });
      await biSay([data.reply]);
      await record('chat_turn', {}, [{ type: 'data_sent', what: 'реплика, контекст и переписка за сегодня для Би', consent: true }], 'Ход Би получен.');
      budgetNote.textContent = `Бюджет общения с Би: осталось $${data.budget.remainingUsd.toFixed(4)} из $${data.budget.grantedUsd.toFixed(2)}.`;
      setTalkStatus('');
    } catch (error) {
      setTalkStatus(error.message || 'Ошибка.');
      if (error instanceof ApiError && error.code === 'consent_required') setStep('idle');
    } finally {
      talking = false;
    }
  }

  async function submitTalk(event) {
    event.preventDefault();
    if (!auth || talking) return;
    const text = talkInput.value.trim();
    if (!text && !pendingPhoto) {
      setTalkStatus('Напишите сообщение или приложите фото.');
      return;
    }
    talking = true;
    setTalkStatus('Би думает…');
    try {
      const userLine = text || '(фото)';
      await userSay(userLine);
      talkInput.value = '';
      const transcript = await todaysTranscript({ excludeTrailingUserText: userLine });
      const body = {
        displayName: profile?.name || '',
        transcript,
        lastBiReply: lastBiFromTranscript(transcript),
      };
      if (text) body.text = text;
      const hadPhoto = Boolean(pendingPhoto);
      if (pendingPhoto) body.photoData = pendingPhoto;
      const data = await api.chatTurn(auth.token, body);
      setPhotoPreview(null);
      await biSay([data.reply]);
      await record('chat_turn', {}, [{ type: 'data_sent', what: hadPhoto ? 'текст, фото и переписка за сегодня для Би' : 'реплика и переписка за сегодня для Би', consent: true }], 'Ход Би получен.');
      setTalkStatus('');
    } catch (error) {
      setTalkStatus(error.message || 'Ошибка.');
    } finally {
      talking = false;
    }
  }

  function cameraPermission() {
    return profile?.permissions?.camera ?? null;
  }

  async function onPhotoFromInput(input) {
    const file = input?.files?.[0];
    if (!file) return;
    try {
      setPhotoPreview(await fileToPhotoDataUrl(file));
      setTalkStatus('Фото готово — нажмите «Отправить».');
    } catch (error) {
      setTalkStatus(error.message || 'Не удалось обработать фото.');
    }
  }

  async function onPhotoCamera() {
    // Camera via file input with capture attribute; ask D1 permission first.
    const permission = cameraPermission();
    if (!permission?.granted) {
      cameraConsent.hidden = false;
      return;
    }
    photoCamera.click();
  }

  async function allowCamera() {
    cameraConsent.hidden = true;
    await updateProfile({ permissions: { ...(profile?.permissions ?? {}), camera: { granted: true, at: new Date().toISOString() } } });
    await record('camera_allowed', {}, [{ type: 'permission_granted', device: 'camera' }], 'Разрешение камеры сохранено.');
    photoCamera.click();
  }

  async function declineCamera() {
    cameraConsent.hidden = true;
    await biSay(['Хорошо, можно выбрать фото из файла.']);
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
      replay.hidden = !voiceOn();
      replay.addEventListener('click', () => speak(text, currentVoice));
      item.append(replay);
    }
    log.append(item);
    item.scrollIntoView({ block: 'end', behavior: 'smooth' });
  }

  function refreshReplayButtons() {
    const on = voiceOn();
    for (const button of log.querySelectorAll('.msg-replay')) button.hidden = !on;
  }

  function voiceOn() {
    return Boolean(profile?.voiceEnabled !== false && mode === 'voice' && currentVoice);
  }

  function syncVoiceToggles() {
    const on = voiceOn();
    if (voiceEnabledMenu) voiceEnabledMenu.checked = on;
    if (voiceEnabledTalk) voiceEnabledTalk.checked = on;
    const canVoice = speechSupported() && Boolean(currentVoice || profile?.voice || voices.length);
    if (voiceEnabledMenu) voiceEnabledMenu.disabled = !canVoice && !on;
    if (voiceEnabledTalk) voiceEnabledTalk.disabled = !canVoice && !on;
    refreshReplayButtons();
  }

  async function setVoiceEnabled(enabled) {
    if (enabled) {
      if (!speechSupported()) {
        syncVoiceToggles();
        await biSay(['На этом устройстве нет озвучки — остаюсь в тексте.']);
        return;
      }
      if (!currentVoice) {
        voices = pickVoices(await loadVoices());
        currentVoice = findVoice(voices, profile?.voice) || voices[0] || null;
      }
      if (!currentVoice) {
        await updateProfile({ voiceEnabled: false });
        syncVoiceToggles();
        await biSay([prompts.noVoicesHere]);
        showVoiceHelpIfNeeded();
        return;
      }
      mode = 'voice';
      unlockSpeech();
      await updateProfile({
        voiceEnabled: true,
        mode: 'voice',
        voice: profile?.voice ?? { uri: currentVoice.voiceURI, name: currentVoice.name, lang: currentVoice.lang },
        voiceDeclined: false,
      });
      syncVoiceToggles();
      return;
    }
    stopSpeaking();
    await updateProfile({ voiceEnabled: false });
    syncVoiceToggles();
  }

  // Returns the program fact about speech, or null when Bi only wrote.
  async function biSay(messages) {
    for (const text of messages) {
      appendMessage('bi', text);
      await storage.addMessage('bi', text);
    }
    if (!voiceOn()) return null;
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
    await updateProfile({
      mode: 'voice',
      voiceEnabled: true,
      voice: { uri: voice.voiceURI, name: voice.name, lang: voice.lang },
      voiceDeclined: false,
    });
    syncVoiceToggles();
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
    await updateProfile({ mode: 'text', voice: null, voiceDeclined: true, voiceEnabled: false });
    syncVoiceToggles();
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

  // micPermissionNow is set synchronously in the «Разрешить» click, so listening can start inside that gesture
  // while the permission is still being written to IndexedDB.
  function micPermission() {
    return micPermissionNow ?? profile?.permissions?.microphone ?? null;
  }

  function refreshMic() {
    micButton.hidden = !recognitionSupported();
    micRevoke.hidden = !micPermission()?.granted;
  }

  function setMicPermission(permission) {
    micPermissionNow = permission;
    refreshMic();
    return updateProfile({ permissions: { ...(profile?.permissions ?? {}), microphone: permission } });
  }

  function showListening(on) {
    micButton.classList.toggle('listening', on);
    micButton.setAttribute('aria-pressed', String(on));
    micButton.setAttribute('aria-label', on ? 'Остановить запись' : 'Ответить голосом');
    micButton.textContent = on ? '■' : '🎤';
  }

  function startListening() {
    const permission = micPermission();
    if (micDecision({ supported: recognitionSupported(), permission }) !== 'listen') return;
    stopSpeaking();
    const before = nameInput.value;
    let session;
    try {
      session = listenOnce({ onInterim: (text) => (nameInput.value = text) });
    } catch (error) {
      biSay([micErrorReply(error.message)]);
      return;
    }
    listening = session;
    showListening(true);
    session.promise
      .then(async (text) => {
        nameInput.value = text || before;
        const facts = [
          { type: 'permission_confirmed', device: 'microphone', grantedAt: permission.at },
          { type: 'device_used', device: 'microphone' },
          { type: 'audio_to_recognizer' },
        ];
        if (text) facts.push({ type: 'text_inserted' });
        await biSay([text ? prompts.micHeard : prompts.micNothingHeard]);
        await record('listened', {}, facts, text ? 'Текст вставлен в поле ответа.' : 'Ничего не расслышано.');
      }, async (error) => {
        nameInput.value = before;
        await biSay([micErrorReply(error.code ?? error.message)]);
      })
      .finally(() => {
        listening = null;
        showListening(false);
        nameInput.focus();
      });
  }

  async function onMic() {
    if (listening) {
      listening.stop();
      return;
    }
    const decision = micDecision({ supported: recognitionSupported(), permission: micPermission() });
    if (decision === 'listen') startListening();
    else if (decision === 'ask') {
      await biSay([prompts.askMicrophone]);
      micConsent.hidden = false;
    }
  }

  async function allowMic() {
    micConsent.hidden = true;
    const said = userSay('Разрешаю микрофон');
    const saved = setMicPermission({ granted: true, at: new Date().toISOString() });
    startListening();
    await said;
    await saved;
    await record('mic_allowed', {}, [{ type: 'permission_granted', device: 'microphone' }], 'Разрешение сохранено на этом устройстве.');
  }

  async function declineMic() {
    micConsent.hidden = true;
    await userSay('Не сейчас');
    await biSay([prompts.micDeclined]);
  }

  async function revokeMic() {
    menu.open = false;
    listening?.stop();
    await setMicPermission({ granted: false, at: new Date().toISOString() });
    await biSay([prompts.micRevoked]);
    await record('mic_revoked', {}, [{ type: 'permission_revoked', device: 'microphone' }], 'Разрешение снято.');
  }

  async function start() {
    storage = await openStorage();
    const supported = speechSupported();
    voices = pickVoices(supported ? await loadVoices() : []);
    profile = await storage.getProfile();

    refreshMic();

    const history = await storage.recentMessages(HISTORY_LIMIT);
    for (const message of history) appendMessage(message.role, message.text, { earlier: true });

    const result = opening({ profile, speechSupported: supported, voices });
    mode = result.mode;
    currentVoice = mode === 'voice' ? findVoice(voices, profile?.voice) : null;
    if (profile?.voiceEnabled === false) {
      /* keep mode/voice for quick re-enable via checkbox */
    } else if (mode === 'voice' && currentVoice && profile?.voiceEnabled === undefined) {
      await updateProfile({ voiceEnabled: true });
    }
    syncVoiceToggles();

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
    listening?.stop();
    await storage.deleteAll();
    profile = null;
    mode = null;
    currentVoice = null;
    ratingEventId = null;
    micPermissionNow = null;
    micConsent.hidden = true;
    refreshMic();
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
    listening?.stop();
    show(false);
    if (location.hash === '#bi') history.replaceState(null, '', location.pathname + location.search);
  }

  function onVoiceToggle(event) {
    const enabled = event.target.checked;
    if (voiceEnabledMenu) voiceEnabledMenu.checked = enabled;
    if (voiceEnabledTalk) voiceEnabledTalk.checked = enabled;
    setVoiceEnabled(enabled).catch((error) => console.warn(error));
  }
  voiceEnabledMenu?.addEventListener('change', onVoiceToggle);
  voiceEnabledTalk?.addEventListener('change', onVoiceToggle);

  textModeButton.addEventListener('click', chooseTextMode);
  document.getElementById('chat-voice-recheck').addEventListener('click', recheckVoices);
  micButton.addEventListener('click', onMic);
  document.getElementById('chat-mic-allow').addEventListener('click', allowMic);
  document.getElementById('chat-mic-decline').addEventListener('click', declineMic);
  micRevoke.addEventListener('click', revokeMic);
  consentAccept.addEventListener('click', () => acceptConsent().catch((e) => setTalkStatus(e.message)));
  startAi.addEventListener('click', () => beginAiTalk().catch((e) => setTalkStatus(e.message)));
  talkForm.addEventListener('submit', submitTalk);
  document.getElementById('chat-photo-pick').addEventListener('click', () => photoFile.click());
  document.getElementById('chat-photo-cam').addEventListener('click', () => onPhotoCamera().catch((e) => setTalkStatus(e.message)));
  photoFile.addEventListener('change', () => onPhotoFromInput(photoFile));
  photoCamera.addEventListener('change', () => onPhotoFromInput(photoCamera));
  photoClear.addEventListener('click', () => setPhotoPreview(null));
  document.getElementById('chat-camera-allow').addEventListener('click', () => allowCamera().catch((e) => setTalkStatus(e.message)));
  document.getElementById('chat-camera-decline').addEventListener('click', () => declineCamera());
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
