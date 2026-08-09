// ─────────────────────────────────────────────────
//  Restart Watch — рестарт перестаёт быть незаметным
// ─────────────────────────────────────────────────
//
// Why: 02.08 контейнер убивало ядром по cgroup, 09.08 — V8 по heap limit. Оба
// раза docker молча поднимал процесс по restart:unless-stopped, и оба раза оператор
// узнал случайно, спустя часы. Тот же класс, что мёртвые стопы 07–11.07 и
// вставший тик 31.07: бот умирает ТИХО.
//
// [Mem] предупреждает ДО упора, tickWatchdog ловит замерший тик — но ни то, ни
// другое не срабатывает, если процесс умер мгновенно и поднялся за 25 мс. Нужен
// сигнал по самому факту: «я только что перезапустился, и прошлый раз это было
// не по-хорошему».
//
// Приём — грязный флаг. Файл data/last_exit.json:
//   • при штатном shutdown пишем clean:true;
//   • сразу после старта — clean:false (мы «в полёте»);
//   • на следующем старте clean:false означает, что прошлый процесс до своего
//     shutdown не дожил, то есть его убили или он упал.
// Первый запуск (файла нет) молчит: там нечему быть нештатным.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join } from 'path';
import { logger } from '../core/logger.js';
import { fireAdoptNtfy } from './adoptReconcile.js';

const DEFAULT_FILE = join('data', 'last_exit.json');
let FILE = DEFAULT_FILE;

function write(payload) {
  if (process.env.NODE_ENV === 'test' && FILE === DEFAULT_FILE) return;
  const tmpPath = `${FILE}.${process.pid}.tmp`;
  try {
    mkdirSync('data', { recursive: true });
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    renameSync(tmpPath, FILE);
  } catch (err) {
    logger.warn(`[RestartWatch] Save failed: ${err.message}`);
  }
}

function read() {
  if (process.env.NODE_ENV === 'test' && FILE === DEFAULT_FILE) return null;
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8'));
  } catch {
    return null;   // ENOENT (первый запуск) или битый файл — в обоих случаях молчим
  }
}

/** Человекочитаемая длительность: «3д 4ч», «12м». */
export function humanDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}д ${h % 24}ч`;
  if (h > 0) return `${h}ч ${m % 60}м`;
  return `${m}м`;
}

/**
 * Чистое решение (для тестов): что это за старт.
 *   'first'      — маркера нет, первый запуск;
 *   'graceful'   — прошлый процесс завершился штатно (перезапуск руками/деплой);
 *   'unexpected' — прошлый процесс до shutdown не дожил → трубим.
 */
export function classifyStart(marker) {
  if (!marker || typeof marker !== 'object') return 'first';
  return marker.clean === true ? 'graceful' : 'unexpected';
}

/**
 * Вызывается на старте, ПОСЛЕ инициализации логгера и ntfy.
 * Трубит, если прошлый запуск оборвался, и переводит маркер в «в полёте».
 */
export async function reportRestartIfUnclean(now = Date.now()) {
  const marker = read();
  const kind = classifyStart(marker);

  if (kind === 'unexpected') {
    const ranFor = marker?.startedAt ? humanDuration(now - marker.startedAt) : '?';
    logger.error(
      `[RestartWatch] 🚨 прошлый запуск оборвался без штатного shutdown ` +
      `(проработал ${ranFor}) — OOM-kill, heap limit или kill -9`,
    );
    await fireAdoptNtfy(
      '🔄 Бот перезапустился сам',
      `Прошлый процесс не дожил до штатного shutdown (проработал ${ranFor}).\n` +
      `Причины по опыту: cgroup OOM-kill (правда в dmesg, inspect врёт oom=false) ` +
      `или FATAL heap limit V8 (dmesg при этом чист).\n` +
      `Жёсткие стопы лежат на бирже и это пережили; пик adopt-трейла восстановлен с диска.`,
      ['arrows_counterclockwise'],
    );
  } else if (kind === 'graceful') {
    logger.info('[RestartWatch] прошлый запуск завершился штатно');
  } else {
    logger.info('[RestartWatch] маркера нет — считаю это первым запуском');
  }

  write({ clean: false, startedAt: now });
  return kind;
}

/** Вызывается из shutdown(): помечает выход как штатный. */
export function markCleanShutdown(now = Date.now()) {
  write({ clean: true, stoppedAt: now });
}

// ── Test helpers ──────────────────────────────────────────────────────────
export function _setFileForTest(path) { FILE = path; }
export function _resetForTest() { FILE = DEFAULT_FILE; }
