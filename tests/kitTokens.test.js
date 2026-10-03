// Переходник на body ссылается на переменные @flwls/ui: страница без CSS кита теряет цвета,
// а verify и сборка этого не видят.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const WEB = 'src/modules/dashboard/web';

test('каждая страница витрины грузит CSS кита в своём входе', () => {
  const missing = [];
  for (const html of readdirSync(WEB).filter((f) => f.endsWith('.html'))) {
    const src = readFileSync(join(WEB, html), 'utf8').match(/<script[^>]*src="\.?\/?([\w-]+\.js)"/)?.[1];
    if (!src) continue;
    const entry = readFileSync(join(WEB, src), 'utf8');
    if (!entry.includes('import "@flwls/ui/tokens.css"')) missing.push(`${html} → ${src}`);
  }
  assert.deepEqual(missing, []);
});

test('переходник подключён один раз — на body', () => {
  const tokens = readFileSync(join(WEB, 'src/styles/core/_tokens.scss'), 'utf8');
  assert.match(tokens, /^body \{\n {2}@include kit-adapter;\n\}/m);
});
