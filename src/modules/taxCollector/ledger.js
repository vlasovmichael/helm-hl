// ─────────────────────────────────────────────────
//  Ledger — годовой PIT-38 гроссбух
// ─────────────────────────────────────────────────
// Хранит налоговые записи в data/tax/<year>_ledger.json.
// Дедупликация по tx_id — повторный запуск крона безопасен.

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { join } from 'path';
import { logger } from '../../core/logger.js';

const TAX_DIR = 'data/tax';

function ledgerPath(year) {
  return join(TAX_DIR, `${year}_ledger.json`);
}

/**
 * Загружает гроссбух за год. Если файла нет — возвращает пустой массив.
 */
export async function loadLedger(year) {
  try {
    const raw = await readFile(ledgerPath(year), 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logger.warn(`[Ledger] Read ${year} failed: ${err.message} — starting empty`);
    }
    return [];
  }
}

/**
 * Атомарная запись (через .tmp + rename).
 */
async function persistLedger(year, entries) {
  await mkdir(TAX_DIR, { recursive: true });
  const finalPath = ledgerPath(year);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(entries, null, 2), 'utf-8');
  await rename(tmpPath, finalPath);
}

/**
 * Группирует записи по году (Europe/Warsaw — налоговый календарь).
 */
function groupByYear(entries) {
  const groups = new Map();
  for (const e of entries) {
    const year = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'Europe/Warsaw',
      year: 'numeric',
    }).format(new Date(e.date));
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(e);
  }
  return groups;
}

/**
 * Добавляет новые записи в гроссбух. Дубликаты по tx_id игнорируются.
 * Возвращает { added, skipped } — счётчики.
 *
 * @param {Array<Object>} newEntries — нормализованные записи (после classifier + nbp)
 */
export async function appendEntries(newEntries) {
  if (!Array.isArray(newEntries) || newEntries.length === 0) {
    return { added: 0, skipped: 0 };
  }

  // Группируем по году, чтобы открыть каждый файл только раз
  const byYear = groupByYear(newEntries);

  let totalAdded = 0;
  let totalSkipped = 0;

  for (const [year, candidates] of byYear) {
    const existing = await loadLedger(year);
    const knownIds = new Set(existing.map((e) => e.tx_id));

    const fresh = [];
    for (const c of candidates) {
      if (knownIds.has(c.tx_id)) {
        totalSkipped++;
      } else {
        fresh.push(c);
        knownIds.add(c.tx_id);
      }
    }

    if (fresh.length > 0) {
      const merged = [...existing, ...fresh].sort(
        (a, b) => new Date(a.date) - new Date(b.date),
      );
      await persistLedger(year, merged);
      totalAdded += fresh.length;
      logger.info(`[Ledger] ${year}: +${fresh.length} new entries (${merged.length} total)`);
    } else {
      logger.debug(`[Ledger] ${year}: no new entries`);
    }
  }

  return { added: totalAdded, skipped: totalSkipped };
}

/**
 * Агрегаты для года: суммы COST/REVENUE/profit в PLN.
 *
 * @param {number|string} year
 * @returns {Promise<{ year, totalCostsPLN, totalRevenuePLN, netProfitPLN, count }>}
 */
export async function getYearSummary(year) {
  const entries = await loadLedger(year);

  let totalCostsPLN   = 0;
  let totalRevenuePLN = 0;

  for (const e of entries) {
    const pln = parseFloat(e.pln_total);
    if (!isFinite(pln)) continue;
    if (e.type === 'COST')         totalCostsPLN   += pln;
    else if (e.type === 'REVENUE') totalRevenuePLN += pln;
  }

  return {
    year:            String(year),
    totalCostsPLN:   round2(totalCostsPLN),
    totalRevenuePLN: round2(totalRevenuePLN),
    netProfitPLN:    round2(totalRevenuePLN - totalCostsPLN),
    count:           entries.length,
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}
