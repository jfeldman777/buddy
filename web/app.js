import { registerServiceWorker, detectPlatform, isStandalone } from './pwa.js';
import { initChat } from './chat.js';
import { openStorage } from './storage.js';

registerServiceWorker();

const meetButton = document.getElementById('meet-button');
const welcomeBack = document.getElementById('welcome-back');
const installButton = document.getElementById('install-button');
const installSection = document.getElementById('install');
const installStatus = document.getElementById('install-status');
const installPromptButton = document.getElementById('install-prompt-button');

let deferredInstallPrompt = null;

function showProfile(profile) {
  if (profile?.name) {
    welcomeBack.textContent = `С возвращением, ${profile.name}!`;
    welcomeBack.hidden = false;
    meetButton.textContent = 'Продолжить с Би';
  } else {
    welcomeBack.hidden = true;
    meetButton.textContent = 'Познакомиться с Би';
  }
}

const chat = initChat({ onProfileChange: showProfile });

meetButton.addEventListener('click', () => chat.open({ fromGesture: true }));
if (location.hash === '#bi') chat.open();

openStorage().then((storage) => storage.getProfile()).then(showProfile).catch((error) => console.warn(error));

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
