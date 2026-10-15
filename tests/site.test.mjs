import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { SITE_URL, QR_OPTIONS, makeQrSvg } from '../tools/make-qr.mjs';
import { nextVersion } from '../tools/bump-version.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WEB = join(ROOT, 'web');
const read = (path) => readFile(join(ROOT, path), 'utf8');
const exists = (path) => access(path).then(() => true, () => false);

function localRefs(html) {
  return [...html.matchAll(/(?:href|src)="([^"]+)"/g)]
    .map((m) => m[1])
    .filter((ref) => !/^(https?:|mailto:|#)/.test(ref))
    .map((ref) => (ref === './' ? 'index.html' : ref.split(/[?#]/)[0]));
}

async function loadPng(path) {
  return PNG.sync.read(await readFile(join(WEB, path)));
}

function pixel(png, x, y) {
  const i = (png.width * Math.round(y) + Math.round(x)) * 4;
  return [png.data[i], png.data[i + 1], png.data[i + 2]];
}

test('стартовая страница содержит всё, что требует раздел 3 ТЗ', async () => {
  const html = await read('web/index.html');
  assert.match(html, /<h1>Buddy<\/h1>/);
  assert.match(html, /Опыт трудных побед/);
  assert.match(html, /Би — ваш ИИ-партнёр\. Он помогает справляться с трудностями, находить решения и приобретать собственный опыт побед\./);
  assert.match(html, />Познакомиться с Би</);
  assert.match(html, />Установить Buddy</);
  assert.match(html, /<img src="qr\.svg"/);
  assert.match(html, /Условия работы и оплаты/);
  assert.match(html, /data-platform="ios"/);
  assert.match(html, /data-platform="android"/);
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
});

test('на стартовой странице есть разговор с Би: выбор голоса, имя, настройки', async () => {
  const html = await read('web/index.html');
  for (const id of ['chat', 'chat-log', 'chat-voices', 'chat-text-mode', 'chat-name-form', 'chat-name', 'chat-change-voice', 'chat-change-name', 'chat-forget', 'welcome-back', 'chat-voice-help', 'chat-voice-recheck', 'chat-rating', 'chat-journal']) {
    assert.match(html, new RegExp(`id="${id}"`), `нет элемента #${id}`);
  }
  assert.match(html, /Без голоса — только текст/);
  for (const platform of ['android', 'ios', 'windows', 'mac']) {
    assert.match(html, new RegExp(`id="chat-voice-help"[\\s\\S]*data-platform="${platform}"`), `нет инструкции по голосу для ${platform}`);
  }
  assert.match(html, /Speech Services by Google/);
  const css = await read('web/styles.css');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;/, 'стили с display перекроют атрибут hidden');
});

test('журнал поступков Би: просмотр, экспорт, удаление, оценка «Да / Нет / Не знаю»', async () => {
  const html = await read('web/journal.html');
  for (const id of ['journal-list', 'journal-export', 'journal-clear', 'journal-empty', 'journal-status']) {
    assert.match(html, new RegExp(`id="${id}"`), `нет элемента #${id}`);
  }
  assert.match(html, /только на этом устройстве/);
  assert.match(html, /declarations\.html/);
  const index = await read('web/index.html');
  for (const answer of ['yes', 'no', 'unsure']) assert.match(index, new RegExp(`data-answer="${answer}"`));
  assert.match(index, /href="journal\.html"/);
  const page = await read('web/journal-page.js');
  assert.doesNotMatch(page, /fetch\((?!'declarations\.json')/, 'страница журнала ничего не отправляет по сети');
});

test('D2: на сервер Buddy ходит только api.js, остальной код ничего не отправляет', async () => {
  for (const file of (await readdir(WEB)).filter((f) => f.endsWith('.js') && f !== 'sw.js')) {
    const text = await read(`web/${file}`);
    assert.doesNotMatch(text, /XMLHttpRequest|sendBeacon|WebSocket/i, `${file} отправляет данные`);
    if (!['api.js', 'config.js'].includes(file)) assert.doesNotMatch(text, /method:\s*['"]POST|API_BASE/i, `${file} обращается к серверу в обход api.js`);
    const allowed = ["'declarations.json'", "'version.json'", ...(file === 'api.js' ? ['...args'] : [])];
    for (const call of text.matchAll(/fetch\(([^,)]*)/g)) {
      assert.ok(allowed.includes(call[1].trim()), `${file}: неожиданный запрос fetch(${call[1]})`);
    }
  }
});

test('D2: разговоры, имя и журнал не попадают в модули, которые ходят на сервер', async () => {
  const network = /from '\.\/(api|account|turnstile|config)\.js'/;
  for (const file of ['app.js', 'chat.js', 'dialogue.js', 'speech.js', 'listen.js', 'storage.js', 'journal.js', 'journal-page.js', 'declarations.js', 'pwa.js']) {
    assert.doesNotMatch(await read(`web/${file}`), network, `${file} подключает сетевой модуль`);
  }
  for (const file of ['api.js', 'account.js', 'account-page.js', 'admin-page.js', 'turnstile.js']) {
    const text = await read(`web/${file}`);
    assert.doesNotMatch(text, /getProfile|saveProfile|recentMessages|addMessage|readJournal|addJournalEntry/, `${file} читает личные данные`);
  }
  assert.doesNotMatch(await read('web/api.js'), /storage\.js/, 'api.js не должен иметь доступа к хранилищу');
});

test('страница учётной записи: passkey, код восстановления, честное описание данных', async () => {
  const html = await read('web/account.html');
  for (const id of ['account-create', 'account-login', 'account-recover-form', 'account-code', 'account-create-code', 'account-code-reveal', 'account-code-value', 'account-code-saved', 'account-code-done', 'account-add-passkey', 'account-new-code', 'account-logout', 'account-turnstile', 'account-unavailable']) {
    assert.match(html, new RegExp(`id="${id}"`), `нет элемента #${id}`);
  }
  assert.match(html, /Имя, разговоры с Би и журнал остаются на этом устройстве и на сервер не отправляются/);
  assert.match(html, /Код показывается один раз/);
  assert.match(html, /Cloudflare Turnstile/);
  const page = await read('web/account-page.js');
  assert.doesNotMatch(page, /saveAccount\([^)]*recoveryCode/, 'код восстановления не сохраняется на устройстве');
  assert.doesNotMatch(await read('web/account.js'), /recoveryCode/, 'код восстановления не сохраняется на устройстве');
  const admin = await read('web/admin.html');
  assert.match(admin, /noindex/);
  assert.match(admin, /только по passkey/);
});

test('D1: к микрофону обращается только listen.js, камера не используется', async () => {
  for (const file of (await readdir(WEB)).filter((f) => f.endsWith('.js') || f.endsWith('.html'))) {
    const text = await read(`web/${file}`);
    assert.doesNotMatch(text, /getUserMedia|mediaDevices/, `${file} обращается к микрофону или камере напрямую`);
    if (file !== 'listen.js') assert.doesNotMatch(text, /SpeechRecognition/, `${file} обращается к распознаванию речи в обход listen.js`);
    if (!['listen.js', 'chat.js'].includes(file)) assert.doesNotMatch(text, /listenOnce/, `${file} включает микрофон`);
  }
  const listen = await read('web/listen.js');
  assert.match(listen, /continuous = false/, 'микрофон слушает только одну фразу');
});

test('D1: chat.js включает микрофон только после проверки сохранённого разрешения', async () => {
  const chat = await read('web/chat.js');
  const calls = [...chat.matchAll(/listenOnce\(/g)];
  assert.equal(calls.length, 1, 'микрофон включается в одном месте');
  const body = chat.match(/function startListening\(\) \{([\s\S]*?)\r?\n {2}\}\r?\n/)?.[1];
  assert.ok(body, 'нет функции startListening');
  const guard = body.indexOf("micDecision({ supported: recognitionSupported(), permission }) !== 'listen') return;");
  assert.ok(guard >= 0, 'startListening не проверяет разрешение');
  assert.ok(guard < body.indexOf('listenOnce('), 'проверка разрешения должна идти до включения микрофона');
  assert.doesNotMatch(chat, /requestSubmit\(|nameForm\.submit\(/, 'распознанный текст не отправляется без человека');
});

test('стартовая страница не обещает автоматическую установку', async () => {
  const html = await read('web/index.html');
  assert.doesNotMatch(html, /установится автоматически|автоматическ\w+ установк/i);
  assert.match(html, /устанавливать не обязательно/);
});

test('все локальные ссылки страниц указывают на существующие файлы', async () => {
  for (const page of (await readdir(WEB)).filter((f) => f.endsWith('.html'))) {
    const html = await read(`web/${page}`);
    for (const ref of localRefs(html)) {
      assert.ok(await exists(join(WEB, ref)), `${page}: нет файла ${ref}`);
    }
  }
});

test('манифест PWA корректен', async () => {
  const manifest = JSON.parse(await read('web/manifest.webmanifest'));
  assert.equal(manifest.id, '/buddy/', 'id считается от корня домена и должен быть уникальным среди проектов jfeldman777.github.io');
  assert.equal(manifest.short_name, 'Buddy');
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, './');
  assert.equal(manifest.scope, './');
  assert.equal(manifest.lang, 'ru');
  for (const size of [192, 512]) {
    for (const purpose of ['any', 'maskable']) {
      const icon = manifest.icons.find((i) => i.sizes === `${size}x${size}` && i.purpose === purpose);
      assert.ok(icon, `нет значка ${size}x${size} (${purpose})`);
      const png = await loadPng(icon.src);
      assert.equal(png.width, size);
      assert.equal(png.height, size);
    }
  }
});

test('значок: ярко-зелёный квадрат, белый круг с чёрной границей, чёрные буквы внутри', async () => {
  for (const file of ['icons/icon-512.png', 'icons/icon-192.png', 'icons/apple-touch-icon.png']) {
    const png = await loadPng(file);
    const s = png.width;
    assert.deepEqual(pixel(png, 2, 2), [40, 255, 55], `${file}: угол не зелёный`);
    assert.deepEqual(pixel(png, s / 2, s * 0.135), [0, 0, 0], `${file}: нет чёрной границы круга`);
    assert.deepEqual(pixel(png, s / 2, s * 0.2), [255, 255, 255], `${file}: круг не белый`);
    let dark = 0;
    for (let x = s * 0.3; x < s * 0.7; x++) if (pixel(png, x, s * 0.55)[0] < 64) dark++;
    assert.ok(dark > s * 0.03, `${file}: не видно букв в центре`);
  }
});

test('service worker кэширует только существующие файлы', async () => {
  const sw = await read('web/sw.js');
  assert.match(sw, /const CACHE_VERSION = `buddy-\$\{VERSION\}`/);
  const shell = [...sw.match(/const APP_SHELL = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(shell.length > 5);
  for (const file of shell) {
    assert.ok(await exists(join(WEB, file === './' ? 'index.html' : file)), `sw.js: нет файла ${file}`);
  }
  for (const file of (await readdir(WEB)).filter((f) => /\.(js|html|css|json|webmanifest)$/.test(f) && f !== 'sw.js')) {
    assert.ok(shell.includes(file), `sw.js: ${file} не попадёт в офлайн-кэш`);
  }
});

test('номер версии одинаковый в version.json, sw.js и на всех страницах', async () => {
  const { version } = JSON.parse(await read('web/version.json'));
  assert.match(version, /^\d{3}$/);
  assert.equal((await read('web/sw.js')).match(/const VERSION = '(\d{3})';/)?.[1], version, 'sw.js: другая версия — выполните npm run bump');
  for (const page of (await readdir(WEB)).filter((f) => f.endsWith('.html'))) {
    const html = await read(`web/${page}`);
    const shown = [...html.matchAll(/<span data-version>([^<]*)<\/span>/g)].map((m) => m[1]);
    assert.ok(shown.length > 0, `${page}: номер версии не показан`);
    for (const value of shown) assert.equal(value, version, `${page}: показана версия ${value}, а не ${version}`);
    assert.match(html, /data-check-update/, `${page}: нет кнопки «Проверить обновления»`);
  }
  assert.equal(nextVersion('003'), '004');
  assert.equal(nextVersion('099'), '100');
  assert.throws(() => nextVersion('v4'));
});

test('QR-код ведёт на адрес сайта', async () => {
  assert.equal(SITE_URL, 'https://jfeldman777.github.io/buddy/');
  assert.equal(await read('web/qr.svg'), await makeQrSvg(), 'web/qr.svg устарел: выполните npm run qr');
  const png = PNG.sync.read(await QRCode.toBuffer(SITE_URL, { ...QR_OPTIONS, type: 'png', scale: 8 }));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(decoded?.data, SITE_URL);
});

test('декларации D1–D7 совпадают с техзаданием', async () => {
  const { declarations } = JSON.parse(await read('web/declarations.json'));
  const spec = await read('docs/spec-001.md');
  assert.deepEqual(declarations.map((d) => d.id), ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7']);
  for (const d of declarations) {
    assert.ok(['program', 'review'].includes(d.check), `${d.id}: неизвестный способ проверки`);
    assert.ok(spec.includes(`**${d.id}. ${d.title}.** ${d.text}`), `${d.id} расходится с docs/spec-001.md`);
  }
});

test('в репозитории нет секретов и оригиналов .docx', async () => {
  const patterns = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /(OPENAI_API_KEY|TELEGRAM_BOT_TOKEN|RECOVERY_PEPPER|TURNSTILE_SECRET)\s*[=:]\s*['"]?(?!test-)[A-Za-z0-9]/,
  ];
  const gitignore = await read('.gitignore');
  assert.match(gitignore, /^\*\.docx$/m);
  assert.match(gitignore, /^\.dev\.vars$/m);
  assert.match(gitignore, /^\.wrangler\/$/m);
  // Everything git would commit: tracked files plus untracked ones that are not ignored.
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: ROOT, encoding: 'utf8' })
    .split('\0').filter(Boolean);
  assert.ok(files.includes('server/wrangler.toml'));
  for (const file of files) {
    assert.doesNotMatch(file, /\.docx$|(^|\/)\.dev\.vars$/, `${file} не должен попасть в репозиторий`);
    if (/\.(png|ico)$/.test(file) || file.endsWith('package-lock.json') || !(await exists(join(ROOT, file)))) continue;
    const text = await readFile(join(ROOT, file), 'utf8');
    for (const pattern of patterns) {
      assert.doesNotMatch(text, pattern, `${file}: похоже на секрет`);
    }
  }
});

test('локальный сервер отдаёт сайт по /buddy/ как GitHub Pages', async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = spawn(process.execPath, [join(ROOT, 'tools/serve.mjs')], { env: { ...process.env, PORT: String(port) } });
  t.after(() => server.kill());
  await new Promise((resolve, reject) => {
    server.stdout.on('data', resolve);
    server.on('error', reject);
  });
  const base = `http://localhost:${port}`;

  const page = await fetch(`${base}/buddy/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Опыт трудных побед/);

  const manifest = await fetch(`${base}/buddy/manifest.webmanifest`);
  assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/);

  const root = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/buddy/');

  const traversal = await fetch(`${base}/buddy/..%2Fpackage.json`);
  assert.notEqual(traversal.status, 200);
});
