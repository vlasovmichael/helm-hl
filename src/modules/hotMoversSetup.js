// ─────────────────────────────────────────────────
//  Hot Movers — чистое ядро Setup-вердикта + чейз-метр (для ntfy-воркера)
// ─────────────────────────────────────────────────
// ⚠️ Это СЕРВЕРНАЯ копия логики из dashboard/public/app.js (computeMomentum +
// hmEntryBadge). app.js грузится классическим <script> без модулей — общий
// импорт невозможен, поэтому логика продублирована. Менять СИНХРОННО с app.js.
// Тесты tests/hotMoversSetup.test.js фиксируют поведение.
//
// Упрощение против карточки: accel/vol-тюнинг score (±15%) здесь опущен —
// для алерта «иди посмотри» направление+режим+чейз важнее доводки очков.

const MOM_WEIGHTS = { 2: 0.2, 5: 0.4, 15: 0.8, 60: 1.2 };

// OI-режим: 15m дельта надёжнее (5m шумная), берём её если есть.
export function deriveOiKind({ oiDelta15m, oiDelta5m } = {}) {
  if (typeof oiDelta15m === 'number' && isFinite(oiDelta15m)) {
    if (oiDelta15m >= 1) return 'up';
    if (oiDelta15m <= -1) return 'down';
    return 'flat';
  }
  if (typeof oiDelta5m === 'number' && isFinite(oiDelta5m)) {
    if (oiDelta5m >= 0.5) return 'up';
    if (oiDelta5m <= -0.5) return 'down';
    return 'flat';
  }
  return null;
}

/**
 * Setup-вердикт по окнам цены + OI. OI решает режим: trend = по движению,
 * fade = против. Без OI — направление по движению, mode не подтверждён.
 *
 * @param {Array<{mins:number, spikePct:number|null}>} windows
 * @param {{oiDelta5m?:number|null, oiDelta15m?:number|null}} oi
 * @returns {{side:'LONG'|'SHORT'|null, mode:'trend'|'fade'|null, score:number}}
 */
export function evaluateSetup(windows, oi) {
  let weighted = 0;
  let haveData = false;
  for (const w of windows || []) {
    if (w?.spikePct == null) continue;
    const wt = MOM_WEIGHTS[w.mins];
    if (wt == null) continue;
    weighted += w.spikePct * wt;
    haveData = true;
  }
  if (!haveData) return { side: null, mode: null, score: 0 };

  const priceUp = weighted > 0;
  const score = Math.abs(weighted);
  const oiKind = deriveOiKind(oi);

  let side, mode;
  if (oiKind === 'up') {
    mode = 'trend';
    side = priceUp ? 'LONG' : 'SHORT';
  } else if (oiKind === 'down') {
    mode = 'fade';
    side = priceUp ? 'SHORT' : 'LONG';
  } else {
    mode = null; // OI флэт / нет данных — режим не подтверждён
    side = priceUp ? 'LONG' : 'SHORT';
  }
  return { side, mode, score };
}

// Чейз-метр (зеркало hmEntryBadge): растяжка В СТОРОНУ СДЕЛКИ от короткой
// средней (15m окно, fallback 5m). Знак по side: + = цена уже ушла в твою
// сторону (опоздал), ≤0 = у базы / ещё не пошло (вход рядом).
export const ENTRY_ZONE_PCT = 0.5;
export const ENTRY_EXT_PCT = 2.5;
export const ENTRY_MIN_SCORE = 3; // = порог рамки Setup (score≥3 + mode); зеркало app.js

/**
 * @returns {{state:'zone'|'mid'|'extended'|'none', extDir:number|null, win:number|null}}
 */
export function classifyChase(windows, side, score) {
  if (!side || !(score >= ENTRY_MIN_SCORE)) return { state: 'none', extDir: null, win: null };
  const pick = (m) => (windows || []).find((w) => w?.mins === m);
  const ref15 = pick(15);
  const ref5 = pick(5);
  const ref =
    ref15 && ref15.spikePct != null ? ref15 : ref5 && ref5.spikePct != null ? ref5 : null;
  if (!ref) return { state: 'none', extDir: null, win: null };
  const extDir = side === 'LONG' ? ref.spikePct : -ref.spikePct;
  if (extDir <= ENTRY_ZONE_PCT) return { state: 'zone', extDir, win: ref.mins };
  if (extDir >= ENTRY_EXT_PCT) return { state: 'extended', extDir, win: ref.mins };
  return { state: 'mid', extDir, win: ref.mins };
}

// ── Фичи монеты + решение об алерте (чистые, для воркера hotMoversAlerts) ─────

export const WINDOWS_MIN = [2, 5, 15, 60];

/**
 * Окна spikePct + OI-дельты монеты из истории. deps инжектятся (priceNMinAgo,
 * oiNMinAgo) — модуль остаётся config-free и тестируемым.
 *
 * @param {{coin:string, price:number, oiUsd:number|null}} item
 * @returns {{windows:Array, oiDelta5m:number|null, oiDelta15m:number|null}}
 */
export function buildCoinFeatures(item, now, deps) {
  const { priceNMinAgo, oiNMinAgo } = deps;
  const price = item.price;
  const windows = WINDOWS_MIN.map((mins) => {
    const past = priceNMinAgo(item.coin, mins, now);
    const spikePct =
      price != null && past != null && past > 0 ? ((price - past) / past) * 100 : null;
    return { mins, spikePct };
  });
  const oiNow = item.oiUsd;
  const oiP5 = oiNMinAgo(item.coin, 5, now);
  const oiP15 = oiNMinAgo(item.coin, 15, now);
  const oiDelta5m = oiNow != null && oiP5 != null && oiP5 > 0 ? ((oiNow - oiP5) / oiP5) * 100 : null;
  const oiDelta15m = oiNow != null && oiP15 != null && oiP15 > 0 ? ((oiNow - oiP15) / oiP15) * 100 : null;
  return { windows, oiDelta5m, oiDelta15m };
}

/**
 * Решает, надо ли пушить по монете, и обновляет prevByCoin. Пуш = направленный
 * подтверждённый Setup (mode + score≥minScore) ПЕРЕШЁЛ в зону 🎯 из любого
 * не-zone состояния (улетел → откатился). Первое наблюдение и флип стороны не
 * пушат (анти-спам на старте).
 *
 * @returns {{fire:boolean, side:string|null, mode:string|null, score:number, chase:object}}
 */
export function evaluateCoinAlert(item, feats, prevByCoin, minScore) {
  const setup = evaluateSetup(feats.windows, {
    oiDelta5m: feats.oiDelta5m,
    oiDelta15m: feats.oiDelta15m,
  });
  const chase = classifyChase(feats.windows, setup.side, setup.score);
  const actionable = !!setup.mode && setup.score >= minScore;
  const curState = actionable ? chase.state : 'none';

  const prev = prevByCoin.get(item.coin);
  prevByCoin.set(item.coin, { side: setup.side, state: curState });

  const fire =
    actionable &&
    chase.state === 'zone' &&
    !!prev &&
    prev.side === setup.side &&
    prev.state !== 'zone';

  return { fire, side: setup.side, mode: setup.mode, score: setup.score, chase };
}
