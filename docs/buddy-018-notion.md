# Buddy-018 · Шаг 1. Чтение Notion

Минимальный канал: Worker читает одну учебную страницу Notion через официальный API и отдаёт Markdown администратору. UI обучения и запись в память Би — следующие шаги.

## Что сделано

- Модуль [`server/src/notion/readPage.js`](../server/src/notion/readPage.js): нормализация id, рекурсивные `blocks/.../children`, Markdown (заголовки, списки, цитаты, ссылки).
- `GET /admin/notion/page` — только elevated admin; по умолчанию первая глава:
  - id `3f622db3-cb08-8059-8c37-e17046263550`
  - url `https://app.notion.com/p/1-3f622db3cb0880598c37e17046263550`
- Параметры: `?id=` и опционально `?url=`.
- Автотесты на фикстуре: [`server/test/notion.test.mjs`](../server/test/notion.test.mjs).
- Секрет: `NOTION_TOKEN` (не в репозитории).

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
5. Задеплоить Worker, если ещё не задеплоен код шага 1:
   ```powershell
   npx wrangler deploy --config server/wrangler.toml
   ```

## Проверка

Войти администратором (passkey), затем с токеном сессии:

`GET https://buddy-api.jfeldman777.workers.dev/admin/notion/page`

Ответ: `{ sourceUrl, pageId, title, text, complete, unknownBlockTypes, errors }`.
