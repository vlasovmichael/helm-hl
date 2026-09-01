// ─────────────────────────────────────────────────
//  winnersJournal — журнал событий «Гениев Уолл-стрит»
// ─────────────────────────────────────────────────
// Пуш от winnersWatch — единственный след события, и он холодный (priority 2):
// телефон не звенит, письмо не уходит, в колокольчике строчка тонет за сутки.
// Витрина /lab показывает только то, что открыто ПРЯМО СЕЙЧАС — закрытая поза
// исчезает бесследно. 01.09.2026 из-за этого пришлось восстанавливать чужую
// сделку постфактум запросами userFills к API, хотя сторож видел её вживую.
//
// Здесь то же самое событие оседает на диск строкой JSONL, и у закрытия к нему
// добавлен ИСХОД: сколько человек снял или потерял. Без этого лента отвечает на
// «что он сделал», но не на «чем кончилось» — а спрашивают всегда второе.
//
// ⛔ В предзаявленный тест это не входит и входить не должно: вердикт считает
// tools/winners.mjs track по снимкам лидерборда, дата решения 10.11.2026.
// Журнал — чтение постфактум, наблюдение за наблюдением.

import { appendFileSync, readFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../core/logger.js';

const FILE = join('data', 'winners-events.jsonl');
// Событий ~5 в сутки на адрес, строка ~250 байт ⇒ мегабайт это годы. Порог
// нужен не ради места, а чтобы файл нельзя было раздуть багом в диффе.
const MAX_BYTES = 4 * 1024 * 1024;
const KEEP_LINES = 5_000;

/** Дописывает события в журнал. Никогда не бросает: лента не стоит тика сторожа. */
export function appendEvents(events) {
  if (!events?.length) return;
  try {
    mkdirSync('data', { recursive: true });
    appendFileSync(FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    rotateIfHuge();
  } catch (err) {
    logger.warn(`[WinnersJournal] append failed: ${err.message}`);
  }
}

function rotateIfHuge() {
  try {
    if (statSync(FILE).size <= MAX_BYTES) return;
    const kept = readFileSync(FILE, 'utf8').trim().split('\n').slice(-KEEP_LINES);
    writeFileSync(FILE, kept.join('\n') + '\n');
    logger.info(`[WinnersJournal] файл подрезан до ${kept.length} строк`);
  } catch (err) {
    logger.warn(`[WinnersJournal] rotate failed: ${err.message}`);
  }
}

/**
 * Читает журнал: свежие события первыми.
 * @param {{limit?:number, sinceMs?:number}} opts
 */
export function readEvents({ limit = 200, sinceMs = null } = {}) {
  if (!existsSync(FILE)) return [];
  let lines;
  try {
    lines = readFileSync(FILE, 'utf8').trim().split('\n');
  } catch (err) {
    logger.warn(`[WinnersJournal] read failed: ${err.message}`);
    return [];
  }
  const out = [];
  // С конца: свежее интереснее, и на длинном файле не разбираем всё подряд.
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    if (!lines[i]) continue;
    let ev;
    try {
      ev = JSON.parse(lines[i]);
    } catch {
      continue; // недописанная строка после падения — пропускаем молча
    }
    if (sinceMs && ev.ts < sinceMs) break;
    out.push(ev);
  }
  return out;
}

/**
 * Свод по журналу: выиграл / проиграл по закрытым позициям.
 * Считает только события со known исходом — открытия в счёт не идут.
 */
export function summarize(events) {
  const closed = events.filter((e) => Number.isFinite(e.pnlNet));
  const win = closed.filter((e) => e.pnlNet > 0);
  const loss = closed.filter((e) => e.pnlNet <= 0);
  const sum = (a) => a.reduce((s, e) => s + e.pnlNet, 0);
  return {
    events: events.length,
    closed: closed.length,
    win: win.length,
    loss: loss.length,
    winSum: sum(win),
    lossSum: sum(loss),
    net: sum(closed),
  };
}
