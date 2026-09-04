// Регистр имени монеты на шве к бирже.
//
// Why: закрытие позиции из дашборда падало 502 — "No position
// found for KPEPE-PERP". Бот держит монеты в UPPERCASE, а HL требует ТОЧНОЕ
// имя из universe: у k-монет оно со строчной k (kPEPE, kSHIB, kBONK). Тот же
// класс уже ловили на candleSnapshot, и он вернулся в другом месте.
//
// Точечная правка снова оставит дыру, поэтому проверка статическая и сплошная:
// имя монеты уходит наружу либо через perpSymbol() (символ перпа), либо через
// resolveApiCoin() (candleSnapshot). Сырых `${coin}-PERP` и голого `req: {coin`
// в src быть не должно.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = new URL('../src', import.meta.url).pathname;

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    // web/ — браузерный код: universe ему недоступен, а имя монеты он берёт
    // прямо из allMids, то есть уже в точном регистре биржи.
    if (statSync(p).isDirectory()) return ['node_modules', 'dist', 'web'].includes(n) ? [] : walk(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

const files = walk(SRC).map((path) => ({ path, code: readFileSync(path, 'utf8') }));

test('символ перпа собирается только через perpSymbol()', () => {
  const offenders = files
    .filter(({ code }) => /`\$\{coin\}-PERP`/.test(code))
    .map(({ path }) => path.replace(SRC, 'src'));
  assert.deepEqual(
    offenders, [],
    `сырой \`\${coin}-PERP\` теряет строчную k у k-монет — используйте perpSymbol(): ${offenders.join(', ')}`,
  );
});

test('candleSnapshot получает монету через resolveApiCoin()', () => {
  // req: { coin: <expr>, ... } — интересует именно то, что стоит после coin:
  const offenders = [];
  for (const { path, code } of files) {
    for (const m of code.matchAll(/req:\s*\{\s*coin\s*(:\s*([^,}]+))?/g)) {
      const expr = (m[2] ?? 'coin').trim();
      // Литерал ("BTC") регистр не теряет, resolveApiCoin — тем более.
      if (expr.startsWith('"') || expr.startsWith("'")) continue;
      if (expr.includes('resolveApiCoin')) continue;
      // Монету часто резолвят строкой выше и передают переменной.
      if (/^[A-Za-z_$][\w$]*$/.test(expr)
        && new RegExp(`${expr}\\s*=\\s*resolveApiCoin\\(`).test(code)) continue;
      offenders.push(`${path.replace(SRC, 'src')}: ${expr}`);
    }
  }
  assert.deepEqual(
    offenders, [],
    `candleSnapshot требует точное имя из universe — оберните в resolveApiCoin(): ${offenders.join(', ')}`,
  );
});
