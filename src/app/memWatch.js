// ─────────────────────────────────────────────────
//  Mem Watch — тихий OOM-kill получает голос и кривую
// ─────────────────────────────────────────────────
//
// Контейнер, убитый по памяти, не оставляет в логе бота ни строчки: ровный
// пульс, обрыв, старт заново. Цена — секунд десять слепоты и сброшенный пик
// adopt-трейла (он живёт в памяти). Здесь два ответа:
// 1) периодическая строка RSS/heap — отличить утечку (монотонный рост) от
// честного роста кэшей (выход на плато);
// 2) пуш при подходе к потолку — предупреждение ДО смерти, а не археология
// в dmesg после.
//
// 🚨 Потолков ДВА, и трубить надо по тому, который свяжет первым: rss/cgroup и
// heapUsed/heap_size_limit. Node выводит свой heap-лимит из cgroup и ставит
// его НИЖЕ — порог, написанный только по rss, недостижим по построению, и
// падение снова проходит молча.
//
// Порог берём из самого cgroup (memory.max), а не из константы: подняли лимит
// в compose — порог поедет сам.
import fs from 'node:fs';
import v8 from 'node:v8';
import { logger } from '../core/logger.js';
import { state } from './state.js';
import { fireAdoptNtfy } from './adoptReconcile.js';
import { candleCacheStats } from '../modules/candleCache.js';
import { logRecentAllocs } from './allocProbe.js';
import { hlClientStats } from '../core/hlClient.js';

const SAMPLE_EVERY_MS = parseInt(process.env.MEM_WATCH_INTERVAL_MS || '600000', 10);
// 🚨 Залп в сотню мегабайт умещается между двумя редкими замерами: в логе
// остаётся ровная кривая и сразу FATAL. Поэтому поверх обычного замера идёт
// частый лёгкий опрос, который молчит, пока куча не прыгнет разом.
const FAST_EVERY_MS = parseInt(process.env.MEM_WATCH_FAST_INTERVAL_MS || '30000', 10);
const JUMP_BYTES = parseInt(process.env.MEM_WATCH_JUMP_MB || '40', 10) * 1024 * 1024;
// 80% потолка: на замеренном темпе (~200 МБ за 1.5 суток) это несколько часов
// форы — хватит зайти и посмотреть, а не «оно уже упало».
const ALERT_AT = parseFloat(process.env.MEM_WATCH_ALERT_FRACTION || '0.8');
// Один пуш на эпизод; повтор, только если отпустило ниже этого и вернулось.
const REARM_AT = ALERT_AT - 0.1;

let timer = null;
let fastTimer = null;
let alerted = false;
let peakRss = 0;
let firstRss = 0;
let firstAt = 0;
let lastFastHeap = 0;

/**
 * Лимит памяти cgroup в байтах, или null если безлимит/не в контейнере.
 * cgroup v2 отдаёт «max» строкой, v1 — заведомо огромное число.
 */
export function readCgroupLimitBytes() {
  const candidates = [
    '/sys/fs/cgroup/memory.max',                    // v2
    '/sys/fs/cgroup/memory/memory.limit_in_bytes',  // v1
  ];
  for (const path of candidates) {
    try {
      const raw = fs.readFileSync(path, 'utf8').trim();
      if (raw === 'max') return null;
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n) || n <= 0) continue;
      // v1 без лимита пишет ~2^63 — это не потолок, а его отсутствие.
      if (n > 64 * 1024 ** 3) return null;
      return n;
    } catch { /* нет файла — не в контейнере */ }
  }
  return null;
}

/** Чистое решение (для тестов): трубить ли при данной доле занятого потолка. */
export function shouldAlertMemory({ fraction, alreadyAlerted }) {
  if (alreadyAlerted) return false;
  return fraction >= ALERT_AT;
}

/**
 * Какой из двух потолков связывает первым — ядро или V8.
 *
 * Оба реальны и убивают по-разному: cgroup даёт OOM-kill (правда в dmesg,
 * `docker inspect` при этом врёт oom=false), V8 — FATAL heap limit с чистым
 * dmesg. Раньше следили только за первым, а умерли от второго.
 *
 * @param {{rss:number, heapUsed:number, cgroupLimit:number|null, heapLimit:number|null}} p
 * @returns {{kind:'rss'|'heap', fraction:number, used:number, limit:number}|null}
 */
export function pickBindingCeiling({ rss, heapUsed, cgroupLimit, heapLimit }) {
  const candidates = [];
  if (cgroupLimit > 0) candidates.push({ kind: 'rss',  fraction: rss / cgroupLimit,      used: rss,      limit: cgroupLimit });
  if (heapLimit   > 0) candidates.push({ kind: 'heap', fraction: heapUsed / heapLimit,   used: heapUsed, limit: heapLimit });
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.fraction > a.fraction ? b : a));
}

/**
 * Чистое решение (для тестов): считать ли скачок кучи достойным строки в логе.
 *
 * Первый опрос после старта опорной точки не имеет (prev = 0) и обязан молчать,
 * иначе каждый рестарт давал бы ложную «тревогу» на пустом месте.
 *
 * @param {{heapUsed:number, prevHeapUsed:number, jumpBytes:number}} p
 */
export function shouldReportJump({ heapUsed, prevHeapUsed, jumpBytes }) {
  if (!(prevHeapUsed > 0)) return false;
  return heapUsed - prevHeapUsed >= jumpBytes;
}

const mb = (bytes) => Math.round(bytes / 1024 / 1024);

// Снимок кучи на залпе — тяжёлая артиллерия: пауза в секунды и файл размером с
// кучу на диск (диск Oracle не резиновый, см. oracle_disk_cleanup). Поэтому по
// умолчанию ВЫКЛЮЧЕН и включается долей потолка через env, а за один запуск
// пишется ровно один файл. Порог держать высоким: смысл — снять картинку
// близко к смерти, а не на каждом всплеске.
const SNAPSHOT_AT = parseFloat(process.env.MEM_WATCH_SNAPSHOT_FRACTION || '0');
const SNAPSHOT_DIR = process.env.MEM_WATCH_SNAPSHOT_DIR || 'data';
let snapshotTaken = false;

/** Чистое решение (для тестов): писать ли снимок кучи на этом залпе. */
export function shouldWriteSnapshot({ heapUsed, heapLimit, fraction, alreadyTaken }) {
  if (alreadyTaken || !(fraction > 0) || !(heapLimit > 0)) return false;
  return heapUsed / heapLimit >= fraction;
}

function maybeHeapSnapshot(heapUsed, heapLimit) {
  if (!shouldWriteSnapshot({ heapUsed, heapLimit, fraction: SNAPSHOT_AT, alreadyTaken: snapshotTaken })) return;
  snapshotTaken = true;
  try {
    const file = v8.writeHeapSnapshot(`${SNAPSHOT_DIR}/jump-${Date.now()}.heapsnapshot`);
    logger.warn(`[Mem] 📸 снимок кучи на залпе: ${file} (один за запуск)`);
  } catch (err) {
    logger.warn(`[Mem] снимок кучи не удался: ${err.message}`);
  }
}

/**
 * Частый лёгкий опрос: молчит, пока куча не прыгнет разом на JUMP_BYTES.
 * Ничего не пушит — это диагностика для лога, а не риск-алерт (пуш на потолок
 * живёт отдельно, в sample()).
 */
function fastSample() {
  if (state.shuttingDown) return;
  const { rss, heapUsed, heapTotal } = process.memoryUsage();

  if (shouldReportJump({ heapUsed, prevHeapUsed: lastFastHeap, jumpBytes: JUMP_BYTES })) {
    let caches = '';
    try {
      const { total, sizes } = candleCacheStats();
      caches = ` | свечи ${total} (${Object.entries(sizes).map(([k, v]) => `${k}:${v}`).join(' ')})`;
    } catch { /* диагностика не должна ронять замер */ }
    const heapLimit = v8.getHeapStatistics().heap_size_limit || null;
    logger.warn(
      `[Mem] ⚡ скачок кучи +${mb(heapUsed - lastFastHeap)}МБ за ${Math.round(FAST_EVERY_MS / 1000)}с: ` +
      `${mb(lastFastHeap)}→${mb(heapUsed)}МБ${heapLimit ? ` из ${mb(heapLimit)}МБ` : ''} ` +
      `| rss=${mb(rss)}МБ heapTotal=${mb(heapTotal)}МБ${caches}`,
    );
    // Кто именно раздул: топ измеренных операций за минуту до залпа.
    // Без этого в логе рядом остаются только безобидные [Universe] Updated.
    try { logRecentAllocs(60_000); } catch { /* диагностика не роняет замер */ }
    try {
      const { inFlight, queued, weightPct, topLabels } = hlClientStats();
      logger.warn(
        `[Mem] ⚡ HL в этот момент: inFlight=${inFlight} queued=${queued} вес=${weightPct}% ` +
        `| ${topLabels.map((t) => `${t.label}:${t.weight}`).join(' ')}`,
      );
    } catch { /* то же */ }
    maybeHeapSnapshot(heapUsed, heapLimit);
  }

  lastFastHeap = heapUsed;
}

async function sample() {
  if (state.shuttingDown) return;
  const { rss, heapUsed, heapTotal, external } = process.memoryUsage();
  const limit = readCgroupLimitBytes();
  const now = Date.now();

  if (firstAt === 0) { firstAt = now; firstRss = rss; }
  if (rss > peakRss) peakRss = rss;

  // Темп роста — главный различитель утечки и кэша. Плато даёт ~0 МБ/ч.
  const hours = (now - firstAt) / 3_600_000;
  const growth = hours > 0.5 ? `, +${(mb(rss - firstRss) / hours).toFixed(1)}МБ/ч` : '';
  const heapLimit = v8.getHeapStatistics().heap_size_limit || null;
  const share = limit ? ` / ${mb(limit)}МБ (${Math.round((rss / limit) * 100)}%)` : '';
  const heapShare = heapLimit ? ` (${Math.round((heapUsed / heapLimit) * 100)}% от ${mb(heapLimit)}МБ)` : '';
  // Размер кэшей свечей — именно они уронили процесс 09.08. Если подметалка
  // работает, число стоит на месте; поехало вверх — виновник назван сразу.
  let caches = '';
  try {
    const { total, sizes } = candleCacheStats();
    caches = ` | свечи ${total} (${Object.entries(sizes).map(([k, v]) => `${k}:${v}`).join(' ')})`;
  } catch { /* модуль мог не подняться — диагностика не должна ронять замер */ }

  logger.info(
    `[Mem] rss=${mb(rss)}МБ${share} | heap ${mb(heapUsed)}/${mb(heapTotal)}МБ${heapShare} ` +
    `| ext=${mb(external)}МБ | пик=${mb(peakRss)}МБ${growth}${caches}`,
  );

  const binding = pickBindingCeiling({ rss, heapUsed, cgroupLimit: limit, heapLimit });
  if (!binding) return;
  const { kind, fraction, used, limit: ceiling } = binding;
  const what = kind === 'heap' ? 'кучи V8' : 'контейнера';
  const how  = kind === 'heap'
    ? 'при упоре — FATAL heap limit, процесс умирает сам (dmesg будет чист)'
    : 'при упоре ядро убьёт процесс без предупреждения';

  if (shouldAlertMemory({ fraction, alreadyAlerted: alerted })) {
    alerted = true;
    logger.error(
      `[Mem] 🚨 подходим к потолку ${what}: ${mb(used)}МБ из ${mb(ceiling)}МБ ` +
      `(${Math.round(fraction * 100)}%) — ${how}`,
    );
    await fireAdoptNtfy(
      `⚠️ Память ${Math.round(fraction * 100)}% потолка ${what}`,
      `${kind === 'heap' ? 'Heap' : 'RSS'} ${mb(used)}МБ из ${mb(ceiling)}МБ${growth ? ` (рост${growth})` : ''}.\n` +
      `RSS ${mb(rss)}МБ${limit ? ` из ${mb(limit)}МБ` : ''}, heap ${mb(heapUsed)}/${mb(heapTotal)}МБ` +
      `${heapLimit ? ` из ${mb(heapLimit)}МБ` : ''}.${caches}\n` +
      `Дальше — рестарт: ~10с слепоты (пик adopt-трейла теперь переживает, см. adoptTrailStore).`,
      ['warning'],
    );
    return;
  }

  if (alerted && fraction < REARM_AT) {
    alerted = false;
    logger.info(`[Mem] ✅ отпустило: ${Math.round(fraction * 100)}% потолка ${what}`);
  }
}

/** Поднимает наблюдение. В paper тоже полезно: течёт-то один и тот же код. */
export function startMemWatch() {
  if (timer) return;
  const limit = readCgroupLimitBytes();
  timer = setInterval(() => {
    sample().catch((err) => logger.debug(`[Mem] ${err.message}`));
  }, SAMPLE_EVERY_MS);
  timer.unref?.();
  fastTimer = setInterval(() => {
    try { fastSample(); } catch (err) { logger.debug(`[Mem] fast ${err.message}`); }
  }, FAST_EVERY_MS);
  fastTimer.unref?.();
  const heapLimit = v8.getHeapStatistics().heap_size_limit || null;
  logger.info(
    `[Mem] started — замер каждые ${Math.round(SAMPLE_EVERY_MS / 60000)}мин, ` +
    `ловля скачков каждые ${Math.round(FAST_EVERY_MS / 1000)}с (порог +${mb(JUMP_BYTES)}МБ), ` +
    `алерт на ${Math.round(ALERT_AT * 100)}% ближайшего потолка | ` +
    `cgroup ${limit ? `${mb(limit)}МБ` : 'не найден'}, куча V8 ${heapLimit ? `${mb(heapLimit)}МБ` : 'не определён'}`,
  );
  // Первый замер сразу: точка отсчёта для темпа роста, а не через 10 минут.
  sample().catch(() => {});
}

/** Грейсфул-стоп (вызывается из shutdown). */
export function stopMemWatch() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (fastTimer) {
    clearInterval(fastTimer);
    fastTimer = null;
  }
}
