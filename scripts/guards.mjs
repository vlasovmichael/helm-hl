#!/usr/bin/env node
// Все сторожа подряд. Упавший не останавливает остальных: в CI видно сразу всё.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const GUARDS = [
  'checkImports.mjs',
  'checkGlyphs.mjs',
  'checkStyleScope.mjs',
  'checkUiLanguage.mjs',
  'checkComments.mjs',
  'checkEnvTemplate.mjs',
  'checkLabLeak.mjs',
];

const failed = GUARDS.filter((name) => {
  const script = fileURLToPath(new URL(name, import.meta.url));
  return spawnSync(process.execPath, [script], { stdio: 'inherit' }).status !== 0;
});

if (failed.length) {
  console.error(`\nСторожа упали: ${failed.join(', ')}`);
  process.exit(1);
}
