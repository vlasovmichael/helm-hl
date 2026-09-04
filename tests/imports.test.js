// ─────────────────────────────────────────────────
//  Импорты: каждый относительный путь ведёт в существующий файл
// ─────────────────────────────────────────────────
// Зачем: удаление модуля ловится юнит-тестами только там, где модуль
// импортируется тестом. lifecycle.js держал ссылку на снятый wsEntryTick и
// уронил бы прод на старте — тесты при этом были зелёные.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function collect(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!/node_modules|\.git|dist/.test(p)) collect(p, acc);
    } else if (/\.(js|mjs|cjs)$/.test(name)) acc.push(p);
  }
  return acc;
}

test('все относительные импорты разрешаются в существующий файл', () => {
  const broken = [];
  for (const file of collect(join(ROOT, 'src')).concat(collect(join(ROOT, 'tests')))) {
    const src = readFileSync(file, 'utf8');
    const re = /(?:from\s+|import\s*\(\s*|require\(\s*)['"](\.[^'"]+)['"]/g;
    let m;
    while ((m = re.exec(src))) {
      const target = resolve(dirname(file), m[1].split('?')[0]);
      const candidates = [target, `${target}.js`, `${target}.mjs`, `${target}.cjs`, join(target, 'index.js')];
      const ok = candidates.some((c) => {
        try { return statSync(c).isFile(); } catch { return false; }
      });
      if (!ok) broken.push(`${relative(ROOT, file)} → ${m[1]}`);
    }
  }
  assert.deepEqual(broken, [], `битые импорты:\n${broken.join('\n')}`);
});
