# Buddy-018 · Notion

Обучение Би от Создателя: страницы Notion → сервер → Би. Порциями, с проверкой; UI памяти учений — следующие шаги.

## Шаг 1. Чтение страницы (admin API)

Минимальный канал: Worker читает одну учебную страницу через официальный API и отдаёт Markdown администратору.

- Модуль [`server/src/notion/readPage.js`](../server/src/notion/readPage.js): нормализация id, рекурсивные `blocks/.../children`, Markdown.
- `GET /admin/notion/page` — только elevated admin; по умолчанию первая глава:
  - id `3f622db3-cb08-8059-8c37-e17046263550`
  - url `https://app.notion.com/p/1-3f622db3cb0880598c37e17046263550`
- Параметры: `?id=` и опционально `?url=`.
- Автотесты: [`server/test/notion.test.mjs`](../server/test/notion.test.mjs).
- Секрет: `NOTION_TOKEN` (не в репозитории).

## Шаг 2. Notion в чате Би (Создатель)

Когда **admin** в обычном чате присылает ссылку Notion (`notion.so` / `app.notion.com`) — в этом ходе или ранее сегодня в переписке — Worker:

1. Извлекает page id (`findNotionPageRef`).
2. Читает страницу тем же `readNotionPage`.
3. Кладёт Markdown в промпт Би порциями (~24k символов на ход; дочерние и `link_to_page` раскрываются).
4. Если документ длиннее — `notion.totalPortions > 1`; продолжение: напишите **«дальше»** или **«часть 2»**.
5. Би получает явную инструкцию: материал уже прочитан, не просить «вставить текст».

Ответ `POST /chat/turn` дополняется полем `notion` (`ok`, `pageId`, `title`, `portion`, `totalPortions`, …). Аудит: `notion_teach:<pageId>`.

Обычный пользователь со ссылкой Notion: fetch **не** выполняется (`notion: null`) — учебные страницы только для Создателя.

Код: [`server/src/bi/notionTeach.js`](../server/src/bi/notionTeach.js), вызов из [`server/src/bi/routes.js`](../server/src/bi/routes.js). Стратегия чата: `buddy-abi-v2`.

## Шаг 3. Методист: программа по 13 страницам

- Каталог: [`server/src/notion/tuaiIntroCatalog.js`](../server/src/notion/tuaiIntroCatalog.js) (ровно 13 pageId от Создателя).
- Чтение корпуса: [`server/src/notion/readCorpus.js`](../server/src/notion/readCorpus.js), `GET /admin/notion/corpus`.
- Документ: [`docs/curriculum/bi-program-v001.md`](curriculum/bi-program-v001.md) — «Программа обучения Би — версия 001».
- Обучение Би / экзамены / память — не в этом шаге.

Проверка полноты корпуса (эталон): admin + `GET …/admin/notion/corpus` → `complete: true`, 13× `status: "ok"`.

Ещё нет: автоматическое обучение Би, экзаменатор, запись в KB.

## Настройка (один раз)

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → New integration (Internal), Read content.
2. Скопировать Internal Integration Secret.
3. В терминале:
   ```powershell
   cd c:\buddy
   npx wrangler secret put NOTION_TOKEN --config server/wrangler.toml
   ```
   Локально — строка `NOTION_TOKEN=...` в `server/.dev.vars`.
4. На странице Notion: **⋯ → Connections** → подключить эту integration.
5. Задеплоить Worker:
   ```powershell
   npx wrangler deploy --config server/wrangler.toml
   ```

## Проверка

**API:** войти администратором (passkey), затем  
`GET https://buddy-api.jfeldman777.workers.dev/admin/notion/page`  
→ `{ sourceUrl, pageId, title, text, complete, … }`.

**Чат:** войти как admin (elevated), согласие на память Би, отправить ссылку на главу → Би опирается на текст страницы, в ответе API есть `notion.ok: true`.
