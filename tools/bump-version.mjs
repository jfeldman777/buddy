// Raises the site version everywhere at once: web/version.json, web/sw.js and the [data-version] spans in web/*.html.
// Usage: npm run bump        → 003 becomes 004
//        npm run bump -- 010 → sets 010
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const WEB = fileURLToPath(new URL('../web/', import.meta.url));

export function nextVersion(version) {
  if (!/^\d{3}$/.test(version)) throw new Error(`Версия должна быть из трёх цифр, а не «${version}»`);
  return String(Number(version) + 1).padStart(3, '0');
}

export async function setVersion(version) {
  if (!/^\d{3}$/.test(version)) throw new Error(`Версия должна быть из трёх цифр, а не «${version}»`);
  await writeFile(join(WEB, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`);
  const swPath = join(WEB, 'sw.js');
  await writeFile(swPath, (await readFile(swPath, 'utf8')).replace(/const VERSION = '\d{3}';/, `const VERSION = '${version}';`));
  for (const file of (await readdir(WEB)).filter((f) => f.endsWith('.html'))) {
    const path = join(WEB, file);
    await writeFile(path, (await readFile(path, 'utf8')).replace(/<span data-version>\d{3}<\/span>/g, `<span data-version>${version}</span>`));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { version } = JSON.parse(await readFile(join(WEB, 'version.json'), 'utf8'));
  const target = process.argv[2] ?? nextVersion(version);
  await setVersion(target);
  console.log(`Версия: ${version} → ${target}`);
}
