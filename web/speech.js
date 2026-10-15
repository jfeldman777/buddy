// Browser speech synthesis. Only output: Buddy never touches the microphone at this stage.

export function speechSupported() {
  return 'speechSynthesis' in globalThis && 'SpeechSynthesisUtterance' in globalThis;
}

export function loadVoices(timeoutMs = 2000) {
  if (!speechSupported()) return Promise.resolve([]);
  const voices = speechSynthesis.getVoices();
  if (voices.length) return Promise.resolve(voices);
  // Chrome fills the list asynchronously; some browsers never fire voiceschanged.
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      speechSynthesis.removeEventListener?.('voiceschanged', done);
      resolve(speechSynthesis.getVoices());
    };
    const timer = setTimeout(done, timeoutMs);
    speechSynthesis.addEventListener?.('voiceschanged', done);
  });
}

// iOS allows speech only after a user gesture; call this synchronously inside the click handler.
export function unlockSpeech() {
  if (!speechSupported()) return;
  const silent = new SpeechSynthesisUtterance('');
  silent.volume = 0;
  speechSynthesis.speak(silent);
}

export function speak(text, voice) {
  if (!speechSupported() || !voice) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.voice = voice;
  utterance.lang = voice.lang;
  speechSynthesis.speak(utterance);
}

export function stopSpeaking() {
  if (speechSupported()) speechSynthesis.cancel();
}
