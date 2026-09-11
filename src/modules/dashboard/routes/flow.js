// ─────────────────────────────────────────────────
//  Flow — витрина потока ордеров HL с адресами участников
// ─────────────────────────────────────────────────
// Читает базу, которую наполняет tools/flowCollector.mjs (контейнер hl-flow).
// Три среза, каждый из которых на CEX построить нельзя в принципе:
//   • кошельки — кто торгует, чем и в какой роли (агрессор или маркет-мейкер);
//   • карта ликвидаций — где по цене стоят чужие вынужденные закрытия;
//   • нетто-поток — куда агрессивно набирают прямо сейчас.
//
// ⚠️ Витрина ОПИСЫВАЕТ, а не предсказывает: ни одного вердикта «покупать» тут
// нет и быть не должно, пока класс не прошёл предзаявленный форвард.
//
// База чужая и только на чтение: коллектор живёт в своём контейнере, дашборд
// в неё не пишет и её отсутствие переживает (сбор мог ещё не стартовать).

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { logger } from '../../../core/logger.js';

const DB_F = path.join('data', 'flow', 'flow.db');
const BAR_MS = 300_000;

let db = null;
let lastTry = 0;

/** Ленивое подключение: база появляется только когда коллектор сделал первый бар. */
function conn() {
  if (db) return db;
  if (Date.now() - lastTry < 30_000) return null;
  lastTry = Date.now();
  if (!fs.existsSync(DB_F)) return null;
  try {
    db = new Database(DB_F, { readonly: true, fileMustExist: true });
    db.pragma('busy_timeout = 3000');
  } catch (err) {
    logger.warn(`[Flow] база недоступна: ${err.message}`);
    db = null;
  }
  return db;
}

/** Ноль без позиций = «не знаем», а не «пусто»: см. ловушку unified ниже. */
const eqKnown = (eq, pos) => (eq === undefined || (!eq && !pos?.length) ? null : eq);

const hoursBack = (req, def) => {
  const h = Number(req.query.hours);
  return Number.isFinite(h) && h > 0 && h <= 720 ? h : def;
};
const barsSince = (hours) => Math.floor((Date.now() - hours * 3_600_000) / BAR_MS);

/** Последний срез позиций — у всех строк одного прохода общий ts. */
function latestPosTs(d) {
  return d.prepare('SELECT MAX(ts) ts FROM positions').get()?.ts ?? null;
}

// ── Кошельки ────────────────────────────────────────────────────────────────
// Роль кошелька определяет доля тейкера в его обороте: 0% — маркет-мейкер,
// стоящий лимитками, 100% — агрессор, который платит за немедленность.
export function handleFlowWallets(req, res) {
  const d = conn();
  if (!d) return res.json({ ok: false, reason: 'collecting', wallets: [] });

  const hours = hoursBack(req, 24);
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const ts = latestPosTs(d);

  try {
    const rows = d.prepare(`
      SELECT a.addr AS addr,
             SUM(f.tbuy + f.tsell + f.mbuy + f.msell) AS vol,
             SUM(f.tbuy + f.tsell) AS taker,
             SUM(f.tbuy + f.mbuy) - SUM(f.tsell + f.msell) AS net,
             SUM(f.fills) AS fills,
             COUNT(DISTINCT f.coin) AS coins
        FROM flow f JOIN addrs a ON a.id = f.addr
       WHERE f.bar >= ?
       GROUP BY f.addr
       ORDER BY vol DESC
       LIMIT ?`).all(barsSince(hours), limit);

    const posBy = new Map();
    if (ts) {
      for (const p of d.prepare(`
        SELECT a.addr AS addr, c.name AS coin, p.szi AS szi, p.entry AS entry,
               p.liq AS liq, p.lev AS lev, p.ntl AS ntl
          FROM positions p JOIN addrs a ON a.id = p.addr JOIN coins c ON c.id = p.coin
         WHERE p.ts = ?`).all(ts)) {
        if (!posBy.has(p.addr)) posBy.set(p.addr, []);
        posBy.get(p.addr).push(p);
      }
    }
    // 🚨 В unified-аккаунте perp clearinghouseState отдаёт accountValue=$0, пока
    // нет открытой перп-позиции — деньги лежат в spot. Показывать такой ноль как
    // капитал значит объявить банкротом половину активных кошельков.
    const eqBy = new Map(ts
      ? d.prepare('SELECT a.addr addr, ac.equity eq FROM accounts ac JOIN addrs a ON a.id = ac.addr WHERE ac.ts = ?')
          .all(ts).map((r) => [r.addr, r.eq])
      : []);

    res.json({
      ok: true, hours, posTs: ts,
      wallets: rows.map((r) => ({
        addr: r.addr,
        vol: r.vol,
        takerPct: r.vol > 0 ? (100 * r.taker) / r.vol : 0,
        net: r.net,
        fills: r.fills,
        coins: r.coins,
        equity: eqKnown(eqBy.get(r.addr), posBy.get(r.addr)),
        positions: (posBy.get(r.addr) ?? []).sort((a, b) => b.ntl - a.ntl),
      })),
    });
  } catch (err) {
    logger.warn(`[Flow] wallets: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── Карта ликвидаций ────────────────────────────────────────────────────────
// Складываем номинал позиций по корзинам цены ликвидации. Лонги и шорты
// раздельно: лонги ликвидируются ВНИЗУ, шорты ВВЕРХУ, и смешивать их в одну
// гистограмму — значит нарисовать стену там, где стоят обе стороны сразу.
export function handleFlowLiqMap(req, res) {
  const d = conn();
  if (!d) return res.json({ ok: false, reason: 'collecting', buckets: [] });

  const coin = String(req.query.coin || 'BTC').toUpperCase();
  const ts = latestPosTs(d);
  if (!ts) return res.json({ ok: false, reason: 'collecting', buckets: [] });

  try {
    const rows = d.prepare(`
      SELECT p.szi AS szi, p.liq AS liq, p.ntl AS ntl, p.lev AS lev, a.addr AS addr
        FROM positions p JOIN coins c ON c.id = p.coin JOIN addrs a ON a.id = p.addr
       WHERE p.ts = ? AND c.name = ? AND p.liq IS NOT NULL AND p.liq > 0`).all(ts, coin);

    if (!rows.length) return res.json({ ok: true, coin, ts, ref: null, buckets: [], total: 0 });

    // Опорная цена — медиана entry: своей цены у витрины нет, а брать её из
    // торгового пути ради картинки значит тратить весовой бюджет HL.
    const entries = rows.map((r) => r.ntl / Math.abs(r.szi)).sort((a, b) => a - b);
    const ref = entries[Math.floor(entries.length / 2)];

    // Корзины в процентах от опорной цены: в абсолютных единицах одна сетка не
    // годится сразу для BTC и для монеты за $0.003.
    const STEP = 1;
    const RANGE = 30;
    const buckets = new Map();
    for (const r of rows) {
      const pct = ((r.liq - ref) / ref) * 100;
      if (Math.abs(pct) > RANGE) continue;
      const k = Math.round(pct / STEP) * STEP;
      let b = buckets.get(k);
      if (!b) { b = { pct: k, longUsd: 0, shortUsd: 0, n: 0 }; buckets.set(k, b); }
      if (r.szi > 0) b.longUsd += r.ntl; else b.shortUsd += r.ntl;
      b.n += 1;
    }

    res.json({
      ok: true, coin, ts, ref,
      total: rows.reduce((s, r) => s + r.ntl, 0),
      wallets: rows.length,
      buckets: [...buckets.values()].sort((a, b) => a.pct - b.pct),
    });
  } catch (err) {
    logger.warn(`[Flow] liqmap: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── Нетто-поток по монете ───────────────────────────────────────────────────
// Считаем ТОЛЬКО тейкерскую сторону: мейкер стоит там, где его исполнили, его
// нетто — след чужой агрессии, а не собственного намерения.
export function handleFlowCoin(req, res) {
  const d = conn();
  if (!d) return res.json({ ok: false, reason: 'collecting', bars: [] });

  const coin = String(req.query.coin || 'BTC').toUpperCase();
  const hours = hoursBack(req, 24);

  try {
    const bars = d.prepare(`
      SELECT f.bar AS bar,
             SUM(f.tbuy) AS buy, SUM(f.tsell) AS sell,
             COUNT(DISTINCT f.addr) AS wallets
        FROM flow f JOIN coins c ON c.id = f.coin
       WHERE c.name = ? AND f.bar >= ?
       GROUP BY f.bar ORDER BY f.bar`).all(coin, barsSince(hours));

    const top = d.prepare(`
      SELECT a.addr AS addr, SUM(f.tbuy) AS buy, SUM(f.tsell) AS sell,
             SUM(f.mbuy + f.msell) AS maker
        FROM flow f JOIN coins c ON c.id = f.coin JOIN addrs a ON a.id = f.addr
       WHERE c.name = ? AND f.bar >= ?
       GROUP BY f.addr
       ORDER BY ABS(SUM(f.tbuy) - SUM(f.tsell)) DESC
       LIMIT 15`).all(coin, barsSince(hours));

    res.json({
      ok: true, coin, hours,
      bars: bars.map((b) => ({ t: b.bar * BAR_MS, buy: b.buy, sell: b.sell, net: b.buy - b.sell, wallets: b.wallets })),
      top: top.map((t) => ({ addr: t.addr, net: t.buy - t.sell, taker: t.buy + t.sell, maker: t.maker })),
    });
  } catch (err) {
    logger.warn(`[Flow] coin: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message });
  }
}

// ── Монеты, по которым есть данные ──────────────────────────────────────────
export function handleFlowCoins(req, res) {
  const d = conn();
  if (!d) return res.json({ ok: false, reason: 'collecting', coins: [] });
  try {
    const rows = d.prepare(`
      SELECT c.name AS name, SUM(f.tbuy + f.tsell + f.mbuy + f.msell) AS vol
        FROM flow f JOIN coins c ON c.id = f.coin
       WHERE f.bar >= ?
       GROUP BY f.coin ORDER BY vol DESC`).all(barsSince(hoursBack(req, 24)));
    res.json({ ok: true, coins: rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
}
