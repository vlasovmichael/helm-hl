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
import { fetchUserFills } from './userFills.js';
import {
  getBotOidsSince,
  getHistorySince,
  getArchivedHistorySince,
  getActivePosition,
} from '../core/database.js';

const VERSION = 1;
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

function emptyMonth() {
  return {
    botPnl: 0, botFees: 0, botCount: 0, botWins: 0,
    adoptedPnl: 0, adoptedFees: 0, adoptedCount: 0, adoptedWins: 0,
    manualPnl: 0, manualFees: 0, manualCount: 0, manualWins: 0,
    funding: 0,
  };
}

function totalCount(m) {
  return (m.botCount || 0) + (m.adoptedCount || 0) + (m.manualCount || 0);
}

// ── reconstruct ВСЕ round-trip сделки (bot + manual), помеченные source ──

function reconstructAllTrades(fills, botOidSet, botByCoin) {
  const useOid = botOidSet instanceof Set && botOidSet.size > 0;
  const LEADING_GRACE_MS = 10_000;
  const TRAILING_GRACE_MS = 60_000;

  function inBotWindow(coin, ts) {
    const ranges = botByCoin.get(coin.toUpperCase()) || [];
    return ranges.some((r) => ts >= r.entry - LEADING_GRACE_MS && ts <= r.close + TRAILING_GRACE_MS);
  }
  function fillIsBot(f) {
    if (useOid && f.oid != null && botOidSet.has(Number(f.oid))) return true;
    return inBotWindow(f.coin, f.time);
  }

  const byCoin = new Map();
  for (const f of fills) {
    if (!f.coin) continue;
    if (!byCoin.has(f.coin)) byCoin.set(f.coin, []);
    byCoin.get(f.coin).push(f);
  }

  const trades = [];
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let cur = null;
    for (const f of list) {
      const isOpen = f.dir.startsWith('Open ');
      const isClose = f.dir.startsWith('Close ');
      if (isOpen) {
        const side = f.dir.includes('Long') ? 'long' : 'short';
        if (!cur) {
          cur = {
            coin, side,
            entryTime: f.time,
            sz: Math.abs(f.sz),
            pnl: 0,
            fee: f.fee,
            openIsBot: fillIsBot(f),
            closeIsBot: false,
          };
        } else {
          cur.sz += Math.abs(f.sz);
          cur.fee += f.fee;
          if (fillIsBot(f)) cur.openIsBot = true;
        }
      } else if (isClose && cur) {
        cur.sz -= Math.abs(f.sz);
        cur.pnl += f.closedPnl;
        cur.fee += f.fee;
        cur.lastCloseTime = f.time;
        if (fillIsBot(f)) cur.closeIsBot = true;
        if (cur.sz <= 1e-9) {
          // Три источника: бот открыл сам → 'bot'; я открыл, а закрыл бот
          // (adopt-нянька подхватила выход) → 'adopted'; и вход, и выход мои
          // → 'manual'.
          const source = cur.openIsBot ? 'bot' : cur.closeIsBot ? 'adopted' : 'manual';
          trades.push({
            coin: cur.coin,
            side: cur.side,
            entryTime: cur.entryTime,
            closeTime: cur.lastCloseTime,
            pnl: cur.pnl,
            fee: cur.fee,
            source,
            status: 'closed',
          });
          cur = null;
        }
      }
    }
    // открытая (незакрытая) позиция в журнал по месяцам не идёт — только closed.
  }
  return trades;
}

// ── снапшот завершённых месяцев ──────────────────

function loadSnapshot() {
  try {
    const raw = readFileSync(SNAPSHOT_FILE, 'utf-8');
    const data = JSON.parse(raw);
    if (data?.version === VERSION && data.months && typeof data.months === 'object') {
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

  // 2. bot oids + bot-позиции (для дедупа bot/manual).
  const botOidSet = getBotOidsSince(0);
  const botByCoin = new Map();
  const botRows = [
    ...getHistorySince(0),
    ...getArchivedHistorySince(0),
  ];
  for (const r of botRows) {
    if (!r?.coin) continue;
    const c = r.coin.toUpperCase();
    if (!botByCoin.has(c)) botByCoin.set(c, []);
    botByCoin.get(c).push({ entry: r.entry_time, close: r.closed_at || r.entry_time });
  }
  const open = getActivePosition();
  if (open?.coin) {
    const c = open.coin.toUpperCase();
    if (!botByCoin.has(c)) botByCoin.set(c, []);
    botByCoin.get(c).push({ entry: open.entry_time, close: Number.POSITIVE_INFINITY });
  }

  // 3. round-trips → агрегация по месяцам (live, из доступного окна).
  const trades = reconstructAllTrades(fills, botOidSet, botByCoin);
  const live = {};
  for (const t of trades) {
    const k = monthKey(t.closeTime || t.entryTime);
    if (!live[k]) live[k] = emptyMonth();
    const m = live[k];
    if (t.source === 'bot') {
      m.botPnl += t.pnl; m.botFees += t.fee; m.botCount += 1;
      if (t.pnl > 0) m.botWins += 1;
    } else if (t.source === 'adopted') {
      m.adoptedPnl += t.pnl; m.adoptedFees += t.fee; m.adoptedCount += 1;
      if (t.pnl > 0) m.adoptedWins += 1;
    } else {
      m.manualPnl += t.pnl; m.manualFees += t.fee; m.manualCount += 1;
      if (t.pnl > 0) m.manualWins += 1;
    }
  }
  for (const f of funding) {
    const k = monthKey(f.ts);
    if (!live[k]) live[k] = emptyMonth();
    live[k].funding += f.usdc;
  }

  // 4. merge со снапшотом ("макс. сделок выигрывает") + заморозка прошлых месяцев.
  const curKey = monthKey(Date.now());
  const snap = loadSnapshot();
  for (const [k, m] of Object.entries(live)) {
    if (k === curKey) continue; // текущий месяц не морозим — он ещё меняется
    if (!snap[k] || totalCount(m) >= totalCount(snap[k])) snap[k] = m;
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
