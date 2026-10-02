// ─────────────────────────────────────────────────────────────────────────────
//  runWhileOpen — запускает сборщик гипотезы, пока она OPEN в реестре.
//
//    HYPOTHESIS_ID=<id> node tools/runWhileOpen.mjs tools/<сборщик>.mjs
//
//  Сверка при старте и раз в час: закрытая гипотеза = выход с кодом 0, и
//  restart: on-failure контейнер обратно не поднимает. Реестр на проде
//  освежает lab pull, поэтому закрытие гипотезы гасит её сборщик само.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { LIFECYCLE_STATUS } from './hypothesisStatus.mjs';

const REGISTRY = resolve('data', 'hypotheses', 'registry.json');
const CHECK_MS = 3_600_000;

/** 'open' | 'closed' | 'unknown' (гипотезы нет в реестре). */
export function hypothesisState(registry, id) {
  const h = (registry?.hypotheses ?? []).find((x) => x.id === id);
  if (!h) return 'unknown';
  return h.status === LIFECYCLE_STATUS.CLOSED ? 'closed' : 'open';
}

const log = (m) => console.log(`[${new Date().toISOString()}] [runWhileOpen] ${m}`);

// Нечитаемый реестр = 'open': живой форвард из-за полузаписанного файла не гасим.
export function readHypothesisState(id) {
  try {
    return hypothesisState(JSON.parse(readFileSync(REGISTRY, 'utf8')), id);
  } catch (e) {
    log(`реестр не прочитан (${e.message}) — продолжаю`);
    return 'open';
  }
}

async function main() {
  const id = process.env.HYPOTHESIS_ID;
  const target = process.argv[2];
  if (!id || !target) {
    console.error('нужны HYPOTHESIS_ID и путь к сборщику');
    process.exit(1);
  }

  const first = readHypothesisState(id);
  if (first === 'unknown') {
    console.error(`гипотезы ${id} нет в реестре`);
    process.exit(1);
  }
  if (first === 'closed') {
    log(`${id} закрыта — сборщик не запускаю`);
    process.exit(0);
  }

  setInterval(() => {
    if (readHypothesisState(id) !== 'closed') return;
    log(`${id} закрыта — останавливаю сборщик`);
    process.exit(0);
  }, CHECK_MS).unref();

  log(`${id} открыта — запускаю ${target}`);
  // Сборщики стартуют по проверке «я главный файл» через argv[1]: без подмены import их не запустит.
  process.argv.splice(1, 2, resolve(target));
  await import(pathToFileURL(resolve(target)).href);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
