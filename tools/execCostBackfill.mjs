// ─────────────────────────────────────────────────────────────────────────────
//  execCostBackfill — залить издержки из уже случившихся филлов
//
//  Живой сбор идёт по WS (src/index.js → recordFill), но у HL лежит окно
//  последних ~2000 своих филлов, и его грех не забрать: это готовая БАЗА «до»
//  для гипотезы про мейкера. Сравнивать «стало» будет с чем.
//
//  🚨 У залитых задним числом строк нет планового стопа и задержки пуша:
//  позиция уже закрыта, а журнал пушей короче. Поля остаются null — так и
//  задумано, гипотеза про проскальзывание считает только по живым строкам.
//
//  Запуск: docker exec hl-paper-scanner node tools/execCostBackfill.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { initDB } from '../src/core/database.js';
import { hlInfo, HL_PRIORITY } from '../src/core/hlClient.js';
import { config } from '../src/core/config.js';
import { classifyFill } from '../src/modules/execCosts.js';
import { recordFillCost } from '../src/core/database.js';

initDB();

const fills = await hlInfo(
  { type: 'userFills', user: config.wallet.address },
  { label: 'execCostBackfill', timeoutMs: 20_000, maxRetries: 3, priority: HL_PRIORITY.LOW },
);
if (!Array.isArray(fills)) {
  console.error('userFills не отдал массив');
  process.exit(1);
}

let added = 0;
let skipped = 0;
for (const f of fills) {
  const row = classifyFill(f);
  if (!row) { skipped++; continue; }
  if (recordFillCost(row)) added++;
}
console.log(`филлов получено: ${fills.length} | записано новых: ${added} | негодных: ${skipped}`);
