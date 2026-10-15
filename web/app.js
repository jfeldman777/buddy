import { registerServiceWorker, detectPlatform, isStandalone } from './pwa.js';

registerServiceWorker();

const meetButton = document.getElementById('meet-button');
const meetSection = document.getElementById('meet');
const installButton = document.getElementById('install-button');
const installSection = document.getElementById('install');
const installStatus = document.getElementById('install-status');
const installPromptButton = document.getElementById('install-prompt-button');

let deferredInstallPrompt = null;

meetButton.addEventListener('click', () => {
  meetSection.hidden = false;
  meetButton.setAttribute('aria-expanded', 'true');
  meetSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

const platform = detectPlatform();
installSection.querySelector(`details[data-platform="${platform}"]`)?.setAttribute('open', '');

function showInstallStatus(text) {
  installStatus.textContent = text;
  installStatus.hidden = false;
}

if (isStandalone()) {
  showInstallStatus('Buddy уже установлен и открыт как приложение.');
}

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installPromptButton.hidden = false;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  installPromptButton.hidden = true;
  showInstallStatus('Buddy установлен. Значок появился на экране устройства.');
});

async function promptInstall() {
  if (!deferredInstallPrompt) return false;
  const promptEvent = deferredInstallPrompt;
  deferredInstallPrompt = null;
  installPromptButton.hidden = true;
  await promptEvent.prompt();
  const { outcome } = await promptEvent.userChoice;
  if (outcome === 'dismissed') showInstallStatus('Установку можно выполнить позже — инструкции ниже.');
  return true;
}

installPromptButton.addEventListener('click', promptInstall);

installButton.addEventListener('click', async () => {
  if (await promptInstall()) return;
  installSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
