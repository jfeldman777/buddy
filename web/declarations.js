import { registerServiceWorker } from './pwa.js';

registerServiceWorker();

const list = document.getElementById('declarations');
const version = document.getElementById('declarations-version');

try {
  const response = await fetch('declarations.json');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  list.replaceChildren(...data.declarations.map((item) => {
    const li = document.createElement('li');
    li.id = item.id;
    const title = document.createElement('strong');
    title.textContent = `${item.id}. ${item.title}.`;
    li.append(title, ` ${item.text}`);
    return li;
  }));
  version.textContent = `Версия ${data.version} от ${data.updated}.`;
} catch (error) {
  console.warn('Декларации не загрузились:', error);
}
