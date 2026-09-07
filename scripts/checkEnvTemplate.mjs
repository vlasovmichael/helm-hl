#!/usr/bin/env node
// Сторож .env.example: 🚨 `KEY=   # пояснение` — не пустое значение. docker
// compose кладёт в env_file весь хвост строки, переменная приезжает в контейнер
// равной тексту комментария и роняет прод крэш-петлёй на старте.
import { readFileSync } from 'node:fs';

const FILE = '.env.example';
const TRAP = /^([A-Z0-9_]+)=\s+#/;

const bad = readFileSync(FILE, 'utf8')
  .split('\n')
  .map((line, i) => ({ line, n: i + 1 }))
  .filter(({ line }) => TRAP.test(line));

if (bad.length) {
  console.error(`❌ ${FILE}: комментарий в строке с переменной — значение уедет в прод целиком`);
  for (const { line, n } of bad) console.error(`   ${n}: ${line.trim()}`);
  console.error('   Перенеси комментарий на строку выше.');
  process.exit(1);
}
console.log(`✅ ${FILE}: ловушек «значение = комментарий» нет`);
