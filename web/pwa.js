const AUTO_CHECK_INTERVAL_MS = 60_000;

export function registerServiceWorker() {
  watchForUpdates();
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => console.warn('Service worker не зарегистрирован:', error));
  });
}

// The number this page was built with; the same number is in version.json and sw.js (npm run bump).
export function currentVersion() {
  return document.querySelector('[data-version]')?.textContent.trim() ?? null;
}

async function publishedVersion() {
  const response = await fetch('version.json', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).version;
}

let banner = null;
let hideTimer = null;

function showBanner(text, action = null) {
  banner ??= Object.assign(document.createElement('div'), { className: 'update-banner', role: 'status' });
  clearTimeout(hideTimer);
  const label = document.createElement('span');
  label.textContent = text;
  banner.replaceChildren(label);
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary btn-small';
    button.textContent = action.label;
    button.addEventListener('click', action.run);
    banner.append(button);
  } else {
    hideTimer = setTimeout(() => banner.remove(), 4000);
  }
  document.body.append(banner);
}

export async function applyUpdate() {
  try {
    await (await navigator.serviceWorker?.getRegistration())?.update();
  } catch (error) {
    console.warn('Service worker не обновился:', error);
  }
  location.reload();
}

// manual: the person pressed «Проверить обновления» and expects an answer either way.
export async function checkForUpdate({ manual = false } = {}) {
  const current = currentVersion();
  let latest;
  try {
    latest = await publishedVersion();
  } catch {
    if (manual) showBanner('Нет связи — проверить обновления не получилось.');
    return null;
  }
  if (current && latest !== current) {
    showBanner(`Вышла новая версия ${latest}.`, { label: 'Обновить', run: applyUpdate });
  } else if (manual) {
    showBanner(`У вас последняя версия — ${current}.`);
  }
  return latest;
}

function watchForUpdates() {
  let lastCheck = 0;
  const autoCheck = () => {
    if (document.visibilityState !== 'visible' || Date.now() - lastCheck < AUTO_CHECK_INTERVAL_MS) return;
    lastCheck = Date.now();
    checkForUpdate();
  };
  window.addEventListener('load', autoCheck);
  document.addEventListener('visibilitychange', autoCheck);
  for (const button of document.querySelectorAll('[data-check-update]')) {
    button.addEventListener('click', () => checkForUpdate({ manual: true }));
  }
}

export function detectPlatform(userAgent = navigator.userAgent, platform = navigator.platform, maxTouchPoints = navigator.maxTouchPoints) {
  const isIOS = /iPad|iPhone|iPod/.test(userAgent) || (platform === 'MacIntel' && maxTouchPoints > 1);
  if (isIOS) return 'ios';
  if (/Android/.test(userAgent)) return 'android';
  return 'desktop';
}

export function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}
