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

import fs from 'node:fs';
import { logger } from '../core/logger.js';
import { state } from './state.js';
import { fireAdoptNtfy } from './adoptReconcile.js';

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
  const share = limit ? ` / ${mb(limit)}МБ (${Math.round((rss / limit) * 100)}%)` : '';

  logger.info(
    `[Mem] rss=${mb(rss)}МБ${share} | heap ${mb(heapUsed)}/${mb(heapTotal)}МБ ` +
    `| ext=${mb(external)}МБ | пик=${mb(peakRss)}МБ${growth}`,
  );

  if (!limit) return;
  const fraction = rss / limit;

  if (shouldAlertMemory({ fraction, alreadyAlerted: alerted })) {
    alerted = true;
    logger.error(
      `[Mem] 🚨 подходим к потолку контейнера: ${mb(rss)}МБ из ${mb(limit)}МБ ` +
      `(${Math.round(fraction * 100)}%) — при упоре ядро убьёт процесс без предупреждения`,
    );
    await fireAdoptNtfy(
      `⚠️ Память ${Math.round(fraction * 100)}% потолка`,
      `RSS ${mb(rss)}МБ из ${mb(limit)}МБ${growth ? ` (рост${growth})` : ''}.\n` +
      `Heap ${mb(heapUsed)}/${mb(heapTotal)}МБ.\n` +
      `При упоре — OOM-kill и рестарт: ~10с слепоты, пик adopt-трейла обнулится.`,
      ['warning'],
    );
    return;
  }

  if (alerted && fraction < REARM_AT) {
    alerted = false;
    logger.info(`[Mem] ✅ отпустило: ${mb(rss)}МБ (${Math.round(fraction * 100)}% потолка)`);
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
  logger.info(
    `[Mem] started — замер каждые ${Math.round(SAMPLE_EVERY_MS / 60000)}мин` +
    (limit
      ? `, потолок ${mb(limit)}МБ, алерт на ${Math.round(ALERT_AT * 100)}%`
      : ', потолок cgroup не найден — только лог'),
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
