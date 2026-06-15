// ─────────────────────────────────────────────────
//  Hot Movers — чистое ядро Setup-вердикта + чейз-метр (для ntfy-воркера)
// ─────────────────────────────────────────────────
// ⚠️ Это СЕРВЕРНАЯ копия логики из dashboard/web/main.js (computeMomentum +
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

// ── Breadth-детектор «слива» (риск-офф / ликвид. каскад) ──────────────────────
// HL не даёт фид ликвидаций, поэтому каскад ловим косвенно: здоровый «выдох» —
// локальный, а каскад/делевередж — ШИРОКИЙ (много топ-муверов синхронно льётся с
// падающим OI). Когда доля таких ≥ порога — fade ПРОТИВ доминирующего движения
// (поймать нож) ненадёжен, и evaluateSetup снимает с него actionable-статус.
export const FLUSH_SHARE = parseFloat(process.env.HOT_MOVERS_FLUSH_SHARE || '0.6');
export const FLUSH_MIN_N = parseInt(process.env.HOT_MOVERS_FLUSH_MIN_N || '6', 10);

// Знак хода монеты для breadth: вес окон как в evaluateSetup (15m/60m доминируют).
function weightedSign(windows) {
  let weighted = 0;
  let have = false;
  for (const w of windows || []) {
    if (w?.spikePct == null) continue;
    const wt = MOM_WEIGHTS[w.mins];
    if (wt == null) continue;
    weighted += w.spikePct * wt;
    have = true;
  }
  return have ? Math.sign(weighted) : 0;
}

/**
 * Доля топ-муверов в синхронном делевередже (OI↓) по каждой стороне. active,
 * когда доминирующая доля ≥ FLUSH_SHARE при ≥ FLUSH_MIN_N монетах с данными.
 *
 * @param {Array<{windows:Array, oiDelta5m?:number|null, oiDelta15m?:number|null}>} rows
 * @returns {{active:boolean, dir:'down'|'up'|null, share:number, n:number}}
 */
export function computeBreadthFlush(rows) {
  let n = 0;
  let flushDown = 0; // цена↓ + OI↓
  let squeezeUp = 0; // цена↑ + OI↓
  for (const r of rows || []) {
    const oiKind = deriveOiKind(r);
    const sign = weightedSign(r?.windows);
    if (sign === 0 || oiKind == null) continue;
    n += 1;
    if (oiKind !== 'down') continue;
    if (sign < 0) flushDown += 1;
    else if (sign > 0) squeezeUp += 1;
  }
  if (n < FLUSH_MIN_N) return { active: false, dir: null, share: 0, n };
  const downShare = flushDown / n;
  const upShare = squeezeUp / n;
  const dir = downShare >= upShare ? 'down' : 'up';
  const share = Math.max(downShare, upShare);
  return { active: share >= FLUSH_SHARE, dir: share >= FLUSH_SHARE ? dir : null, share, n };
}

// Глушим ли fade-вердикт ПРОТИВ доминирующего слива (fade-long в down, fade-short
// в up). trend-вердикты и fade В СТОРОНУ слива не трогаем.
export function isFadeMutedByFlush(side, mode, flush) {
  if (!flush?.active || mode !== 'fade') return false;
  return (
    (flush.dir === 'down' && side === 'LONG') || (flush.dir === 'up' && side === 'SHORT')
  );
}

// Ускорение хода: |2m| vs линейная экстраполяция 5m (×0.4). ≥1.2 = ускоряется
// в сторону движения ('up'), ≤0.6 = выдыхается ('down'), знаки разные = разворот
// ('rev'). ⚠️ Зеркало deriveAccelKind в dashboard/web/src/hotMovers/momentum.js.
export function deriveAccelKind(w2, w5) {
  if (!w2 || !w5 || w2.spikePct == null || w5.spikePct == null) return null;
  const a = w2.spikePct;
  const b = w5.spikePct;
  if (Math.abs(b) < 0.05) return 'flat';
  if (a > 0 !== b > 0 && Math.abs(a) > 0.2) return 'rev';
  const ratio = Math.abs(a) / Math.abs(b * 0.4);
  return ratio >= 1.2 ? 'up' : ratio <= 0.6 ? 'down' : 'flat';
}

// Fade = ставка на ВЫДОХ движения. actionable снимаем, когда выдоха НЕТ:
//  (a) accelKind === 'up' — ход ускоряется в свою сторону (нож разгоняется, не
//      тормозит) → лов ножа, не истощение;
//  (b) фейдим ПО старшему 1h-тренду: fade-short (priceUp) при htfTrend==='up'
//      или fade-long (!priceUp) при htfTrend==='down' — движение по тренду, а
//      не откат под фейд.
// Возвращает причину ('accel'|'htf') или null. ⚠️ Зеркало в momentum.js.
export function fadeExhaustionMuted(mode, priceUp, accelKind, htfTrend) {
  if (mode !== 'fade') return null;
  if (accelKind === 'up') return 'accel';
  if (priceUp && htfTrend === 'up') return 'htf';
  if (!priceUp && htfTrend === 'down') return 'htf';
  return null;
}

/**
 * Setup-вердикт по окнам цены + OI. OI решает режим: trend = по движению,
 * fade = против. Без OI — направление по движению, mode не подтверждён.
 * Если передан flush (breadth-слив) и вердикт = fade против слива — mode
 * снимается (режим не подтверждён), side остаётся: пилл виден, но не actionable.
 * accelKind/htfTrend (опц.) гасят fade без выдоха (см. fadeExhaustionMuted).
 *
 * @param {Array<{mins:number, spikePct:number|null}>} windows
 * @param {{oiDelta5m?:number|null, oiDelta15m?:number|null}} oi
 * @param {{active:boolean, dir:'down'|'up'|null}} [flush]
 * @param {'up'|'down'|'rev'|'flat'|null} [accelKind]
 * @param {'up'|'down'|'none'|null} [htfTrend]
 * @returns {{side:'LONG'|'SHORT'|null, mode:'trend'|'fade'|null, score:number, flushMuted?:boolean, fadeMuted?:string}}
 */
export function evaluateSetup(windows, oi, flush, accelKind = null, htfTrend = null) {
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
  if (isFadeMutedByFlush(side, mode, flush)) {
    return { side, mode: null, score, flushMuted: true };
  }
  const fadeMuted = fadeExhaustionMuted(mode, priceUp, accelKind, htfTrend);
  if (fadeMuted) {
    return { side, mode: null, score, fadeMuted };
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
 * htfTrend (1h-EMA тренд) гасит fade по тренду — fetch'ит воркер и прокидывает.
 *
 * @returns {{fire:boolean, side:string|null, mode:string|null, score:number, chase:object}}
 */
export function evaluateCoinAlert(item, feats, prevByCoin, minScore, flush, htfTrend = null) {
  const w2 = (feats.windows || []).find((w) => w.mins === 2);
  const w5 = (feats.windows || []).find((w) => w.mins === 5);
  const accelKind = deriveAccelKind(w2, w5);
  const setup = evaluateSetup(
    feats.windows,
    { oiDelta5m: feats.oiDelta5m, oiDelta15m: feats.oiDelta15m },
    flush,
    accelKind,
    htfTrend,
  );
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
