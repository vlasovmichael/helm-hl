#!/usr/bin/env node
// Сторож приватности: 🚨 файл под путями лабы, отслеживаемый публичным helm-hl,
// уедет на GitHub при ближайшем push. Пути берутся из блока лабы в .gitignore.
import { filesUnderLab } from './lab.mjs';

const leaked = filesUnderLab('cached');

if (leaked.length) {
  console.error('❌ Файлы лаборатории отслеживаются публичным репозиторием:');
  for (const f of leaked) console.error(`   ${f}`);
  console.error('   Убрать из helm-hl: git rm --cached <файл>, сохранить в лабу: npm run lab:save');
  process.exit(1);
}
console.log('[checkLabLeak] ✅ журнал лаборатории в публичный репозиторий не попадает');
