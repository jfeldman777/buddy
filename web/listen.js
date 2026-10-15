// Browser speech recognition. The only module allowed to touch the microphone (D1);
// callers must check the person's saved permission first. One phrase per call, never continuous listening.

function Recognition() {
  return globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null;
}

export function recognitionSupported() {
  return Recognition() !== null;
}

// Resolves with the final phrase ('' if nothing was heard); rejects with the browser error code
// ('not-allowed', 'audio-capture', 'network', 'service-not-allowed', ...).
export function listenOnce({ lang = 'ru-RU', onInterim } = {}) {
  const SR = Recognition();
  if (!SR) return { promise: Promise.reject(new Error('unsupported')), stop() {} };
  const recognition = new SR();
  recognition.lang = lang;
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  const promise = new Promise((resolve, reject) => {
    let finalText = '';
    let failed = null;
    recognition.onresult = (event) => {
      let interim = '';
      for (const result of event.results) {
        if (result.isFinal) finalText = result[0].transcript;
        else interim += result[0].transcript;
      }
      onInterim?.(finalText || interim);
    };
    recognition.onerror = (event) => {
      if (event.error !== 'no-speech' && event.error !== 'aborted') failed = event.error;
    };
    recognition.onend = () => (failed ? reject(Object.assign(new Error(failed), { code: failed })) : resolve(finalText.trim()));
  });

  recognition.start();
  return { promise, stop: () => recognition.stop() };
}
