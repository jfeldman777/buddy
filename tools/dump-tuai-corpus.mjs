#!/usr/bin/env node
// Dump TUAI intro corpus via official Notion API.
// Usage (PowerShell): set the Notion integration secret in the environment, then:
//   node tools/dump-tuai-corpus.mjs
// Or put the secret in server/.dev.vars and:
//   node tools/dump-tuai-corpus.mjs --dev-vars
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTuaiIntroCorpus } from '../server/src/notion/readCorpus.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const TOKEN_ENV = 'NOTION' + '_TOKEN';

async function loadToken() {
  if (process.env[TOKEN_ENV]) return process.env[TOKEN_ENV].trim();
  if (process.argv.includes('--dev-vars')) {
    const raw = await readFile(join(root, 'server', '.dev.vars'), 'utf8');
    const prefix = `${TOKEN_ENV}=`;
    const line = raw.split(/\r?\n/).find((l) => l.startsWith(prefix) || l.startsWith(`${TOKEN_ENV} =`));
    if (!line) throw new Error(`${TOKEN_ENV} не найден в server/.dev.vars`);
    return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
  }
  throw new Error(`Задайте ${TOKEN_ENV} в окружении или запустите с --dev-vars`);
}

const token = await loadToken();
const env = { FETCH: fetch };
env[TOKEN_ENV] = token;
const corpus = await readTuaiIntroCorpus(env);
const outDir = join(root, 'docs', 'curriculum', 'corpus-dumps');
await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const summaryPath = join(outDir, `corpus-${stamp}.json`);
const slim = {
  ...corpus,
  pages: corpus.pages.map((p) => ({
    n: p.n,
    pageId: p.pageId,
    sourceUrl: p.sourceUrl,
    status: p.status,
    title: p.title,
    charCount: p.charCount,
    complete: p.complete,
    errors: p.errors,
    unknownBlockTypes: p.unknownBlockTypes,
    error: p.error || null,
    textPreview: (p.text || '').slice(0, 240),
  })),
};
await writeFile(summaryPath, `${JSON.stringify(slim, null, 2)}\n`, 'utf8');
const fullPath = join(outDir, `corpus-${stamp}-full.json`);
await writeFile(fullPath, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  complete: corpus.complete,
  okCount: corpus.okCount,
  incompleteCount: corpus.incompleteCount,
  errorCount: corpus.errorCount,
  summaryPath,
  fullPath,
  pages: slim.pages.map((p) => ({
    n: p.n,
    status: p.status,
    title: p.title,
    charCount: p.charCount,
    complete: p.complete,
    errors: p.errors,
    error: p.error,
  })),
}, null, 2));
