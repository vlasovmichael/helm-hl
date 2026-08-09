// ─────────────────────────────────────────────────
//  Mem Watch — тихий OOM-kill получает голос и кривую
// ─────────────────────────────────────────────────
//
// Why (инцидент 2026-08-02): контейнер «сам перезагрузился» дважды за двое
// суток. В логе бота — ни строчки: ровный [Hunter] 💓, обрыв, старт заново.
// Правда нашлась только в dmesg хоста:
//   Memory cgroup out of memory: Killed process (node) anon-rss:254212kB
// Нода упиралась в лимит cgroup (256M), ядро её убивало, docker поднимал по
// restart:unless-stopped. Цена — секунд десять слепоты и сброшенный пик
// adopt-трейла (он живёт в памяти и рестарт не переживает).
//
// Тот же класс, что мёртвые стопы 07–11.07 и вставший тик 31.07: бот умирал
// ТИХО. Здесь два ответа на это:
//   1) периодическая строка RSS/heap — чтобы отличить утечку (монотонный рост)
//      от честного роста кэшей (выход на плато);
//   2) пуш при подходе к потолку — предупреждение ДО того, как убьёт, а не
//      археология в dmesg после.
//
// Порог берём из самого cgroup (memory.max), а не из константы: подняли лимит
// в compose — порог поедет сам, рассинхрона не будет.

// ── Дополнение 2026-08-09: алерт был недостижим ──────────────────────────────
// Второе падение (11:51) пришло НЕ по cgroup, а по потолку самого V8:
//   FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap OOM
// при rss=242МБ из 512 и чистом dmesg. Node 20 выводит heap_size_limit из
// cgroup и поставил себе 259МБ; rss физически не мог дойти до 80% от 512 (это
// 410МБ), потому что процесс умирал раньше — на rss около 242. То есть порог,
// написанный 02.08, был недостижим ПО ПОСТРОЕНИЮ, и оба падения прошли молча.
//
// Поэтому теперь смотрим на два потолка сразу и трубим по тому, который
// связывает первым: rss/cgroup и heapUsed/heap_size_limit.
import fs from 'node:fs';
import v8 from 'node:v8';
import { logger } from '../core/logger.js';
import { state } from './state.js';
import { fireAdoptNtfy } from './adoptReconcile.js';
import { candleCacheStats } from '../modules/candleCache.js';

const SAMPLE_EVERY_MS = parseInt(process.env.MEM_WATCH_INTERVAL_MS || '600000', 10);
// 80% потолка: на замеренном темпе (~200 МБ за 1.5 суток) это несколько часов
// форы — хватит зайти и посмотреть, а не «оно уже упало».
const ALERT_AT = parseFloat(process.env.MEM_WATCH_ALERT_FRACTION || '0.8');
// Один пуш на эпизод; повтор, только если отпустило ниже этого и вернулось.
const REARM_AT = ALERT_AT - 0.1;

let timer = null;
let alerted = false;
let peakRss = 0;
let firstRss = 0;
let firstAt = 0;

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

const mb = (bytes) => Math.round(bytes / 1024 / 1024);

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
  const heapLimit = v8.getHeapStatistics().heap_size_limit || null;
  logger.info(
    `[Mem] started — замер каждые ${Math.round(SAMPLE_EVERY_MS / 60000)}мин, ` +
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
}
