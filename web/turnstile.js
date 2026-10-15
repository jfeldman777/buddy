// Cloudflare Turnstile: a check that a person, not a script, creates accounts and enters recovery codes.
// The script is loaded only on the account page and only when the check is needed.
import { TURNSTILE_SITE_KEY } from './config.js';

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let scriptPromise = null;

function loadTurnstile() {
  scriptPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve(window.turnstile);
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Проверка Cloudflare не загрузилась. Проверьте интернет.'));
    };
    document.head.append(script);
  });
  return scriptPromise;
}

// Shows the widget in container and resolves with a one-time token.
export async function humanCheck(container) {
  if (!TURNSTILE_SITE_KEY) throw new Error('Проверка Cloudflare ещё не настроена.');
  const turnstile = await loadTurnstile();
  container.hidden = false;
  return new Promise((resolve, reject) => {
    let widget = null;
    const done = () => {
      setTimeout(() => turnstile.remove(widget), 0);
      container.hidden = true;
    };
    widget = turnstile.render(container, {
      sitekey: TURNSTILE_SITE_KEY,
      language: 'ru',
      callback: (token) => {
        done();
        resolve(token);
      },
      'error-callback': () => {
        done();
        reject(new Error('Проверка Cloudflare не прошла. Попробуйте ещё раз.'));
      },
      'expired-callback': () => {
        done();
        reject(new Error('Проверка Cloudflare устарела. Попробуйте ещё раз.'));
      },
    });
  });
}
