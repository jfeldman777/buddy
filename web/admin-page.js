import { registerServiceWorker } from './pwa.js';
import { openStorage } from './storage.js';
import { api } from './api.js';
import { currentUser, signInWithPasskey, signOut } from './account.js';

registerServiceWorker();

const $ = (id) => document.getElementById(id);
const status = $('admin-status');
const signedOut = $('admin-signed-out');
const panel = $('admin-panel');
const rows = $('admin-users');

const storage = await openStorage();
let session = null;

function showStatus(text) {
  status.textContent = text;
  status.hidden = !text;
}

const roles = { user: 'пользователь', admin: 'администратор' };
const statuses = { active: 'активна', blocked: 'заблокирована' };

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

async function loadUsers() {
  const { users } = await api.adminUsers(session.token);
  rows.replaceChildren(...users.map((user) => {
    const tr = document.createElement('tr');
    tr.append(
      cell(user.id.slice(0, 8)),
      cell(roles[user.role] ?? user.role),
      cell(statuses[user.status] ?? user.status),
      cell(new Date(user.createdAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })),
      cell(String(user.passkeys)),
    );
    return tr;
  }));
  $('admin-count').textContent = `(${users.length})`;
}

async function show() {
  const admin = Boolean(session?.user.admin);
  panel.hidden = !admin;
  signedOut.hidden = admin;
  if (admin) await loadUsers();
  else if (session) showStatus('Эта учётная запись не администратор, или вход был без passkey с отпечатком, лицом или PIN-кодом.');
}

async function act(action) {
  showStatus('');
  try {
    await action();
  } catch (error) {
    console.warn(error);
    showStatus(error.message || 'Что-то пошло не так. Попробуйте ещё раз.');
  }
}

$('admin-login').addEventListener('click', () => act(async () => {
  const result = await signInWithPasskey(storage);
  session = { token: (await storage.getAccount()).token, user: result.user };
  await show();
}));

$('admin-refresh').addEventListener('click', () => act(loadUsers));

$('admin-logout').addEventListener('click', () => act(async () => {
  await signOut(storage);
  session = null;
  rows.replaceChildren();
  await show();
}));

if (!api.configured) {
  showStatus('Сервер Buddy ещё не подключён.');
} else {
  await act(async () => {
    session = await currentUser(storage);
    await show();
  });
}
