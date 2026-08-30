// ─────────────────────────────────────────────────
//  Ledger — месячный P&L журнал из HL fills (источник правды)
// ─────────────────────────────────────────────────
//
// Зачем: trades.db теряет историю при каждой порче (см. memory: corruption
// 2026-05-20 / 2026-05-25). После rebuild'ов в БД остаётся только хвост.
// Источник правды за весь период торговли (с 8 апреля 2026) — Hyperliquid
// on-chain fills, которые отдаёт userFillsByTime. Этот модуль восстанавливает
// полную помесячную картину прямо из fills и НЕ зависит от trades.db.
//
// Каждый round-trip помечается source: 'bot' | 'adopted' | 'manual':
//   - 'bot'     — открывающий fill принадлежит боту (oid в bot_oid_log, либо
//                 fallback по time-window вокруг bot-позиции).
//   - 'adopted' — вход мой (ручной), но выход закрыл бот (adopt-нянька).
//   - 'manual'  — и вход, и выход мои (ручная сделка через UI).
//
// closedPnl от HL — ДО комиссий (price PnL). Комиссии (fee) идут отдельной
// строкой. Net = Σ closedPnl − Σ fees + funding.
//
// Заморозка прошлых месяцев: userFillsByTime отдаёт ~60 дней. Чтобы апрель не
// "выпал" из окна через месяц, завершённые месяцы фиксируются в
// data/ledger_months.json по правилу "макс. число сделок выигрывает" — когда
// окно полное (сейчас), месяц сохраняется целиком; позже, при усохшем окне,
// частичный пересчёт даёт меньше сделок и НЕ перезаписывает снапшот.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { logger } from '../core/logger.js';
import { config } from '../core/config.js';
import { hlInfo } from '../core/hlClient.js';
import { fetchUserFills, reconstructRoundTrips } from './userFills.js';
import {
  getBotOidsSince,
  getHistorySince,
  getArchivedHistorySince,
  getActivePosition,
} from '../core/database.js';

// v2 = в снапшот добавлена дневная разбивка (months[k].days). Снапшоты v1
// читаются как есть — у их месяцев просто нет дней (разворот покажет прочерк).
const VERSION = 2;
// Аккаунт начал торговать 8 апреля 2026. Берём с 1 апреля с запасом.
const LEDGER_START_MS = Date.UTC(2026, 3, 1);
const SNAPSHOT_FILE = join('data', 'ledger_months.json');
const CACHE_TTL_MS = 60_000;

let cache = { ts: 0, payload: null };

// ── helpers ──────────────────────────────────────

function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

// Понедельник ISO-недели, в которую попал день (UTC).
function weekKey(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const shift = (d.getUTCDay() + 6) % 7;  // Пн=0 … Вс=6
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

function emptyMonth() {
  return {
    botPnl: 0, botFees: 0, botCount: 0, botWins: 0,
    adoptedPnl: 0, adoptedFees: 0, adoptedCount: 0, adoptedWins: 0,
    manualPnl: 0, manualFees: 0, manualCount: 0, manualWins: 0,
    funding: 0,
    days: {},  // 'YYYY-MM-DD' → тот же бакет без .days
  };
}

function emptyDay() {
  const d = emptyMonth();
  delete d.days;
  return d;
}

// Одна проводка кладётся сразу в месячный и в дневной бакет.
function addTrade(bucket, t) {
  const p = t.source === 'bot' ? 'bot' : t.source === 'adopted' ? 'adopted' : 'manual';
  bucket[`${p}Pnl`] += t.pnl;
  bucket[`${p}Fees`] += t.fee;
  bucket[`${p}Count`] += 1;
  if (t.pnl > 0) bucket[`${p}Wins`] += 1;
}

function totalCount(m) {
  return (m.botCount || 0) + (m.adoptedCount || 0) + (m.manualCount || 0);
}

// Реконструкция round-trip'ов вынесена в userFills.reconstructRoundTrips() —
// единый движок для Ledger и дашборда (Activity/Insights). Раньше тут была своя
// копия, которая отстала от net-position фикса и теряла/иначе классифицировала
// деньги (commit 7175611 чинил только userFills, не ledger).

// ── снапшот завершённых месяцев ──────────────────

function loadSnapshot() {
  try {
    const raw = readFileSync(SNAPSHOT_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if ((data?.version === VERSION || data?.version === 1) && data.months && typeof data.months === 'object') {
      return data.months;
    }
  } catch {
    /* нет файла — первый запуск */
  }
  return {};
}

function saveSnapshot(months) {
  try {
    mkdirSync(dirname(SNAPSHOT_FILE), { recursive: true });
    const tmp = `${SNAPSHOT_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: VERSION, months, savedAt: Date.now() }, null, 2));
    renameSync(tmp, SNAPSHOT_FILE);
  } catch (err) {
    logger.debug(`[Ledger] snapshot save failed: ${err.message}`);
  }
}

// ── главный вход ─────────────────────────────────

/**
 * @returns {Promise<{ months: Array, totals: Object, startDate: string, generatedAt: number, live: boolean }>}
 */
export async function getMonthlyLedger() {
  if (Date.now() - cache.ts < CACHE_TTL_MS && cache.payload) return cache.payload;
  if (!config.isProduction) {
    const empty = { months: [], totals: emptyTotals(), startDate: null, generatedAt: Date.now(), live: false };
    cache = { ts: Date.now(), payload: empty };
    return empty;
  }

  // 1. fills + funding с начала торговли (ограничено 60d-окном HL → ниже мерджим снапшот).
  const fills = await fetchUserFills(LEDGER_START_MS);
  const funding = await fetchFunding(LEDGER_START_MS);

  // 2. bot oids + bot-сделки (для дедупа bot/adopted/manual).
  const botOidSet = getBotOidsSince(0);
  const botTrades = [
    ...getHistorySince(0),
    ...getArchivedHistorySince(0),
  ].map((r) => ({ coin: r.coin, entry_time: r.entry_time, closed_at: r.closed_at }));
  const open = getActivePosition();
  if (open?.coin) {
    botTrades.push({ coin: open.coin, entry_time: open.entry_time, closed_at: null, status: 'OPEN' });
  }

  // 3. round-trips → агрегация по месяцам (live, из доступного окна). Только
  // закрытые: открытая поза в месячный журнал не идёт.
  const trades = reconstructRoundTrips(fills, botTrades, botOidSet)
    .filter((t) => t.status === 'closed');
  const live = {};
  const bucketsFor = (ms) => {
    const mk = monthKey(ms);
    if (!live[mk]) live[mk] = emptyMonth();
    const m = live[mk];
    const dk = dayKey(ms);
    if (!m.days[dk]) m.days[dk] = emptyDay();
    return [m, m.days[dk]];
  };
  for (const t of trades) {
    for (const b of bucketsFor(t.closeTime || t.entryTime)) addTrade(b, t);
  }
  for (const f of funding) {
    for (const b of bucketsFor(f.ts)) b.funding += f.usdc;
  }

  // 4. merge со снапшотом + заморозка прошлых месяцев.
  // Завершённый месяц, целиком попадающий в fills-окно HL (~60d), пересчитывается
  // НАСИЛЬНО — это самолечение снапшота под исправленный движок reconstructRoundTrips
  // (старый ledger.reconstructAllTrades мог зафиксировать кривые/фантомные цифры,
  // которые правило "макс. сделок" не давало переписать). Месяцы ВНЕ окна
  // (ранний апрель) пересчитать неоткуда — их снапшот сохраняем как есть.
  const SAFE_RECOMPUTE_MS = 55 * 24 * 3600_000;
  const recomputeFloor = Date.now() - SAFE_RECOMPUTE_MS;
  const monthStartMs = (k) => {
    const [y, mo] = k.split('-').map(Number);
    return Date.UTC(y, mo - 1, 1);
  };
  const curKey = monthKey(Date.now());
  const snap = loadSnapshot();
  for (const [k, m] of Object.entries(live)) {
    if (k === curKey) continue; // текущий месяц не морозим — он ещё меняется
    const fullyInWindow = monthStartMs(k) >= recomputeFloor;
    if (!snap[k] || fullyInWindow || totalCount(m) >= totalCount(snap[k])) snap[k] = m;
  }
  saveSnapshot(snap);

  // 5. финальный набор: прошлые — из снапшота (полнее), текущий — live.
  const merged = {};
  for (const [k, m] of Object.entries(snap)) merged[k] = m;
  for (const [k, m] of Object.entries(live)) {
    if (k === curKey || !merged[k]) merged[k] = m;
  }

  // 6. сборка ответа: отсортированные месяцы + running net + totals.
  const keys = Object.keys(merged).sort();
  let runningNet = 0;
  const months = keys.map((k) => {
    const m = merged[k];
    const botNet = m.botPnl - m.botFees;
    const adoptedNet = (m.adoptedPnl || 0) - (m.adoptedFees || 0);
    const manualNet = m.manualPnl - m.manualFees;
    const net = botNet + adoptedNet + manualNet + m.funding;
    runningNet += net;
    return {
      month: k,
      botPnl: round(m.botPnl), botFees: round(m.botFees), botNet: round(botNet),
      botCount: m.botCount, botWins: m.botWins,
      botWinRate: m.botCount ? Math.round((100 * m.botWins) / m.botCount) : 0,
      adoptedPnl: round(m.adoptedPnl || 0), adoptedFees: round(m.adoptedFees || 0), adoptedNet: round(adoptedNet),
      adoptedCount: m.adoptedCount || 0, adoptedWins: m.adoptedWins || 0,
      adoptedWinRate: m.adoptedCount ? Math.round((100 * m.adoptedWins) / m.adoptedCount) : 0,
      manualPnl: round(m.manualPnl), manualFees: round(m.manualFees), manualNet: round(manualNet),
      manualCount: m.manualCount, manualWins: m.manualWins,
      manualWinRate: m.manualCount ? Math.round((100 * m.manualWins) / m.manualCount) : 0,
      funding: round(m.funding),
      net: round(net),
      cumulativeNet: round(runningNet),
      isCurrent: k === curKey,
      days: buildDays(m.days),
    };
  });

  const totals = emptyTotals();
  for (const m of months) {
    totals.botNet += m.botNet; totals.adoptedNet += m.adoptedNet; totals.manualNet += m.manualNet;
    totals.fees += m.botFees + m.adoptedFees + m.manualFees; totals.funding += m.funding;
    totals.botCount += m.botCount; totals.adoptedCount += m.adoptedCount; totals.manualCount += m.manualCount;
    totals.botWins += m.botWins; totals.adoptedWins += m.adoptedWins; totals.manualWins += m.manualWins;
    totals.net += m.net;
  }
  for (const k of Object.keys(totals)) totals[k] = round(totals[k]);
  totals.botWinRate = totals.botCount ? Math.round((100 * totals.botWins) / totals.botCount) : 0;
  totals.adoptedWinRate = totals.adoptedCount ? Math.round((100 * totals.adoptedWins) / totals.adoptedCount) : 0;
  totals.manualWinRate = totals.manualCount ? Math.round((100 * totals.manualWins) / totals.manualCount) : 0;

  const payload = {
    months,
    totals,
    startDate: '2026-04-08',
    generatedAt: Date.now(),
    live: true,
  };
  cache = { ts: Date.now(), payload };
  return payload;
}

// Дневная разбивка месяца для разворота строки. week = понедельник ISO-недели,
// по нему фронт группирует дни и рисует недельный итог. Дни без активности не
// отдаём — в таблице им нечего показать.
function buildDays(days) {
  if (!days || typeof days !== 'object') return [];
  return Object.keys(days).sort().map((d) => {
    const x = days[d];
    const botNet = x.botPnl - x.botFees;
    const adoptedNet = (x.adoptedPnl || 0) - (x.adoptedFees || 0);
    const manualNet = x.manualPnl - x.manualFees;
    return {
      date: d,
      week: weekKey(d),
      botNet: round(botNet), botCount: x.botCount, botWins: x.botWins,
      adoptedNet: round(adoptedNet), adoptedCount: x.adoptedCount || 0, adoptedWins: x.adoptedWins || 0,
      manualNet: round(manualNet), manualCount: x.manualCount, manualWins: x.manualWins,
      fees: round(x.botFees + (x.adoptedFees || 0) + x.manualFees),
      funding: round(x.funding),
      net: round(botNet + adoptedNet + manualNet + x.funding),
    };
  });
}

function emptyTotals() {
  return {
    botNet: 0, adoptedNet: 0, manualNet: 0, fees: 0, funding: 0, net: 0,
    botCount: 0, adoptedCount: 0, manualCount: 0,
    botWins: 0, adoptedWins: 0, manualWins: 0,
    botWinRate: 0, adoptedWinRate: 0, manualWinRate: 0,
  };
}

function round(x) {
  return Math.round((x + Number.EPSILON) * 100) / 100;
}

async function fetchFunding(startTime) {
  try {
    const data = await hlInfo(
      { type: 'userFunding', user: config.wallet.address, startTime },
      { label: 'ledger/userFunding', timeoutMs: 10_000 },
    );
    if (!Array.isArray(data)) return [];
    return data
      .map((it) => ({ ts: it.time, usdc: parseFloat(it.delta?.usdc ?? '0') }))
      .filter((x) => Number.isFinite(x.usdc) && Number.isFinite(x.ts));
  } catch (err) {
    logger.debug(`[Ledger] funding fetch failed: ${err.message}`);
    return [];
  }
}
