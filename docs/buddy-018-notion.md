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
- Чтение корпуса: [`server/src/notion/readCorpus.js`](../server/src/notion/readCorpus.js), `GET /admin/notion/corpus` (`expandLinkedPages: false`).
- Локальный dump: `node tools/dump-tuai-corpus.mjs --dev-vars`.
- Программы: [v001](curriculum/bi-program-v001.md) (зеркало), [**v002**](curriculum/bi-program-v002.md) (API, корпус полный).

### Шаг 3А
Причина «неполноты» 5/8/10/12 в v001 — обрезка публичного зеркала и скрытые toggle; API + Connections дали `complete: true` для всех 13. В корпусе не вшиваются тела соседних `child_page`.

## Шаг 4. Эксперимент F01 (API + admin)

Один цикл: Методист (F01 из v002) → Экзаменатор составляет 3 новые задачи → Ученик изучает и отвечает → оценка (см. шаг 5) → при необходимости один ретест.

## Шаг 5. Универсальный учебный цикл (F01 / F02)

Тот же порядок ролей, параметр `fragmentId`. Спеки фрагментов — `server/src/teach/fragmentSpecs.js` (по программе v002). Пока allowlist: **F01, F02**. Оценка: **буква** (точное совпадение; `certain`) и **дух** (по смыслу) — дух только если буква сомневается; иначе `spirit: null`. Критериев «смысл»/«применение» нет.

- `POST /admin/teach/run` body `{ "fragmentId": "F01"|"F02" }` (elevated admin)
- Алиас шага 4: `POST /admin/teach/f01/run` → F01
- Код: `fragmentCycle.js`, `prompts.js`, `fragmentSpecs.js`
- UI: выбор фрагмента + «Начать обучение» на `admin.html`
- Результат — **экспериментальная** проверка; в память Би / KB / DCB / обычный чат ничего не пишется
- Успех ≠ «постоянный Би усвоил фрагмент»

### Вердикты Создателя (шаг 5) → журнал разногласий (шаг 6)

**Шаг 6.** «Не согласен» / ручной ввод → сразу `teach_disputes` со статусом `open` + история в `teach_dispute_messages` (append-only). Открытое разногласие — **не** утверждённое знание. Обсуждение с Би: `POST /admin/teach/dispute/discuss`. Закрытие только Создателем (`resolved_bi_error` | `resolved_examiner_error` | `resolved_other`) → запись в `bi_teachings` (`confirmed`) со ссылкой на dispute. В учебных циклах open и resolved попадают в промпт Экзаменатора раздельно.

- `POST /admin/teach/dispute`, `GET /admin/teach/disputes`, `GET /admin/teach/dispute?id=`
- `POST /admin/teach/dispute/message|discuss|resolve`
- Алиасы шага 5: `/admin/teach/ruling`, `/admin/teach/rulings`

## Шаг 7. Управление обучением (утверждено Создателем)

**Роли:** Методист (модель) режет/упорядочивает; Создатель утверждает цепочку и имеет верхний ✓/✗; проверяющие (люди) — ✓/✗; Би идёт по цепочке со стопом.

| Фаза | Содержание | Статус |
| --- | --- | --- |
| **A** | Спеки F01–F15, утверждённая цепочка v002, прогон по шагам со стопом (провал / open разногласие) | в коде |
| **B** | Загрузка файлов (+ Notion), Методист предлагает фрагменты и логический порядок → утверждение Создателя | дальше |
| **C** | Роль проверяющего: согласен / не согласен | дальше |
| **D** | Создатель ✓/✗ поверх проверяющего (частично уже есть через журнал разногласий) | дальше |

Фаза A:
- `GET /admin/teach/fragments`
- `POST /admin/teach/chain/start` → `POST /admin/teach/chain/continue` (один фрагмент за запрос)
- Admin: «Запустить цепочку F01–F15»

Ещё нет: мгновенная переоценка текущего раунда без нового цикла.

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
