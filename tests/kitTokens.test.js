// Дашборд стоит на токенах @flwls/ui: страница без CSS кита или ссылка на неопределённую
// переменную теряет цвета молча, а verify и сборка этого не видят.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';

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

const LEGACY_TOKENS = [
  '--bg', '--canvas-subtle', '--canvas-inset', '--card-bg', '--card-bg-elev',
  '--card-bg-hover', '--border', '--border-muted', '--border-strong', '--hairline',
  '--text-primary', '--text-secondary', '--text-muted', '--text-faint', '--accent',
  '--accent-strong', '--accent-soft', '--accent-line', '--info', '--green',
  '--green-soft', '--green-line', '--red', '--red-soft', '--red-line', '--warn',
  '--warn-soft', '--grid-line', '--chart-ema', '--shadow-sm', '--shadow',
  '--font-sans', '--font-display', '--font-mono', '--fs-micro', '--fs-label',
  '--fs-small', '--fs-body', '--fs-base', '--fs-lead', '--fs-h3', '--fs-h2',
  '--fs-h1', '--fs-hero', '--sp-1', '--sp-2', '--sp-3', '--sp-4', '--sp-5',
  '--sp-6', '--sp-8', '--sp-10',
];

// --shadow — целевой токен для бывшего --shadow-sm; строка --shadow из
// переходника стала --shadow-lift. По одному имени отличить их нельзя.
const KIT_TARGETS = new Set(['--shadow']);
const SOURCE_EXTENSIONS = new Set(['.scss', '.css', '.js', '.html']);

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === 'dist' || entry.name === 'node_modules' ? [] : sourceFiles(path);
    }
    return SOURCE_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

test('в исходниках нет старых имён токенов переходника', () => {
  const stale = LEGACY_TOKENS.filter((token) => !KIT_TARGETS.has(token));
  const occurrences = [];
  for (const path of sourceFiles(WEB)) {
    const text = readFileSync(path, 'utf8');
    for (const token of stale) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      // Ищем только CSS-переменную: var(), её определение или строковый API JS.
      // BEM-модификаторы вроде &--warn не являются токенами.
      const pattern = new RegExp(
        `(?:var\\(\\s*|["'])${escaped}(?=\\s*(?:[,\\)"']))|(?<![\\w-])${escaped}\\s*:`,
      );
      if (pattern.test(text)) occurrences.push(`${path}: ${token}`);
    }
  }
  assert.deepEqual(occurrences, []);
});

// var(--x) без запасного значения на неопределённом имени браузер выбрасывает молча.
test('каждая var(--x) без запасного значения где-то определена', () => {
  const kit = readFileSync('node_modules/@flwls/ui/dist/tokens.css', 'utf8');
  const sources = sourceFiles(WEB).map((path) => [path, readFileSync(path, 'utf8')]);
  const defined = new Set([kit, ...sources.map(([, text]) => text)].flatMap((text) => [
    ...[...text.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]),
    ...[...text.matchAll(/setProperty\(\s*["'](--[\w-]+)/g)].map((m) => m[1]),
  ]));
  const missing = sources.flatMap(([path, text]) =>
    [...text.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)]
      .map((m) => m[1])
      .filter((name) => !defined.has(name))
      .map((name) => `${path}: ${name}`));
  assert.deepEqual([...new Set(missing)], []);
});
