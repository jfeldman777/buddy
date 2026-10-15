import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('wrangler.toml: привязки D1, лимитов и cron объявлены, секретов нет', async () => {
  const toml = await read('wrangler.toml');
  assert.match(toml, /^main = "src\/index\.js"$/m);
  assert.match(toml, /binding = "DB"[\s\S]*migrations_dir = "migrations"/);
  assert.match(toml, /name = "LIMIT_ANON"/);
  assert.match(toml, /name = "LIMIT_USER"/);
  assert.match(toml, /crons = \[/);
  assert.match(toml, /^RP_ID = "jfeldman777\.github\.io"$/m);
  assert.match(toml, /^ALLOWED_ORIGINS = "https:\/\/jfeldman777\.github\.io"$/m, 'только сайт Buddy, без слеша и пути');
  assert.doesNotMatch(toml, /^\s*(RECOVERY_PEPPER|TURNSTILE_SECRET)\s*=/m, 'секреты задаются через wrangler secret put');
  const example = await read('.dev.vars.example');
  for (const name of ['RECOVERY_PEPPER', 'TURNSTILE_SECRET', 'RP_ID', 'ALLOWED_ORIGINS']) assert.match(example, new RegExp(`^${name}=`, 'm'));
});

test('схема D1 не хранит имена, разговоры и журнал', async () => {
  const schema = (await read('migrations/0001_init.sql')).toLowerCase();
  assert.doesNotMatch(schema, /\b(name|display_name|email|phone|message|messages|conversation|journal|text)\b\s+(text|integer|blob)/,
    'на сервере только данные для входа');
  assert.doesNotMatch(schema, /recovery_code\s+text|code\s+text/, 'код восстановления хранится только как HMAC');
  assert.match(schema, /code_hmac text not null unique/);
  assert.match(schema, /token_hash text primary key/);
});
