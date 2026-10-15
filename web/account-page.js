import { registerServiceWorker } from './pwa.js';
import { openStorage } from './storage.js';
import { api } from './api.js';
import { passkeysSupported, PasskeyError } from './webauthn.js';
import { humanCheck } from './turnstile.js';
import {
  currentUser, signUpWithPasskey, signUpWithCode, signInWithPasskey, recoverWithCode, addPasskey, signOut,
} from './account.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const status = $('account-status');
const signedOut = $('account-signed-out');
const signedIn = $('account-signed-in');
const reveal = $('account-code-reveal');
const codeValue = $('account-code-value');
const codeSaved = $('account-code-saved');
const codeDone = $('account-code-done');
const turnstileBox = $('account-turnstile');
const recoverForm = $('account-recover-form');

const storage = await openStorage();
let session = null;

function showStatus(text) {
  status.textContent = text;
  status.hidden = !text;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { dateStyle: 'long' });
}

function render() {
  const user = session?.user;
  const showingCode = !reveal.hidden;
  signedOut.hidden = Boolean(user) || showingCode;
  signedIn.hidden = !user || showingCode;
  if (!user) return;
  $('account-id').textContent = user.id.slice(0, 8);
  $('account-created').textContent = formatDate(user.createdAt);
  $('account-passkeys').textContent = user.passkeys ? String(user.passkeys) : 'нет — вход только по коду';
  $('account-has-code').textContent = user.role === 'admin' ? 'не выдаётся администратору' : user.hasRecoveryCode ? 'есть' : 'нет';
  $('account-admin').hidden = !user.admin;
  $('account-admin-hint').hidden = user.role !== 'admin' || user.admin;
  $('account-new-code').hidden = user.role === 'admin';
}

function showCode(code) {
  codeValue.textContent = code;
  codeSaved.checked = false;
  codeDone.disabled = true;
  reveal.hidden = false;
  render();
  reveal.scrollIntoView({ block: 'start' });
}

// Runs one action at a time, with the buttons locked and errors shown in plain words.
let busy = false;
async function act(action) {
  if (busy) return;
  busy = true;
  const buttons = [...document.querySelectorAll('main button')];
  for (const button of buttons) button.disabled = true;
  showStatus('');
  try {
    await action();
  } catch (error) {
    console.warn(error);
    showStatus(error.message || 'Что-то пошло не так. Попробуйте ещё раз.');
  } finally {
    for (const button of buttons) button.disabled = false;
    codeDone.disabled = !codeSaved.checked;
    busy = false;
  }
}

async function signedInWith(result, message) {
  session = { token: (await storage.getAccount()).token, user: result.user };
  if (result.recoveryCode) showCode(result.recoveryCode);
  render();
  showStatus(message);
}

$('account-create').addEventListener('click', () => act(async () => {
  const token = await humanCheck(turnstileBox);
  await signedInWith(await signUpWithPasskey(storage, token), 'Учётная запись создана, passkey сохранён на этом устройстве.');
}));

$('account-create-code').addEventListener('click', () => act(async () => {
  const token = await humanCheck(turnstileBox);
  await signedInWith(await signUpWithCode(storage, token), 'Учётная запись создана. Войти в неё можно только по коду — сохраните его.');
}));

$('account-login').addEventListener('click', () => act(async () => {
  try {
    await signedInWith(await signInWithPasskey(storage), 'Вы вошли.');
  } catch (error) {
    if (error instanceof PasskeyError && error.code === 'cancelled') {
      throw new PasskeyError(error.code, `${error.message} Если учётной записи ещё нет, входить пока не нужно.`);
    }
    throw error;
  }
}));

recoverForm.addEventListener('submit', (event) => {
  event.preventDefault();
  act(async () => {
    const token = await humanCheck(turnstileBox);
    await signedInWith(await recoverWithCode(storage, recoverForm.code.value, token), 'Вы вошли по коду. Старый код больше не работает — сохраните новый.');
    recoverForm.reset();
  });
});

$('account-add-passkey').addEventListener('click', () => act(async () => {
  const { user } = await addPasskey(session.token);
  session.user = user;
  render();
  showStatus('Passkey добавлен. Теперь можно входить с ним.');
}));

$('account-new-code').addEventListener('click', () => act(async () => {
  if (!window.confirm('Выдать новый код восстановления? Старый код перестанет работать.')) return;
  const { recoveryCode } = await api.newRecoveryCode(session.token);
  session.user.hasRecoveryCode = true;
  showCode(recoveryCode);
  showStatus('Новый код выдан, старый больше не работает.');
}));

$('account-logout').addEventListener('click', () => act(async () => {
  await signOut(storage);
  session = null;
  render();
  showStatus('Вы вышли на этом устройстве.');
}));

$('account-code-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(codeValue.textContent);
    showStatus('Код скопирован. Сохраните его в надёжном месте.');
  } catch {
    showStatus('Не получилось скопировать — перепишите код вручную.');
  }
});

codeSaved.addEventListener('change', () => {
  codeDone.disabled = !codeSaved.checked;
});

codeDone.addEventListener('click', () => {
  codeValue.textContent = '';
  reveal.hidden = true;
  render();
  showStatus('');
});

if (!api.configured) {
  $('account-unavailable').hidden = false;
} else {
  // Creating an account is offered only by a direct link (account.html?create): later Bi opens it when access is arranged.
  $('account-create-block').hidden = !new URLSearchParams(location.search).has('create');
  $('account-no-passkey').hidden = passkeysSupported();
  for (const id of ['account-create', 'account-login']) $(id).hidden = !passkeysSupported();
  if (!storage.persistent) showStatus('Браузер не даёт сохранять данные — например, в приватном режиме. После закрытия страницы придётся войти снова.');
  await act(async () => {
    session = await currentUser(storage);
  });
  render();
}
