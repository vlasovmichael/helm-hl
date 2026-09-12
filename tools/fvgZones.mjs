// ─────────────────────────────────────────────────────────────────────────────
//  Живые FVG-сетапы для будильника: зона ещё в силе и ретест ТОЛЬКО ЧТО
//  случился. Параметры берутся из tools/fvgRule.mjs — единственного источника
//  истины предзаявленной гипотезы; здесь они не переопределяются.
//
//  🚨 Геометрия обязана совпадать с findTrades: будильник зовёт на тот самый
//  сетап, который накапливает форвард. Разойдётся — алерт будет про другую
//  гипотезу, а журнал про эту. Сторож — tests/fvgZones.test.js: он сверяет
//  вход и стоп живого сетапа с тем, что находит findTrades на той же серии.
//
//  Исход здесь не считается: в момент входа он ещё не известен. Поэтому тут
//  нет ни r, ни rNet — только уровни и геометрия.
// ─────────────────────────────────────────────────────────────────────────────
import { PARAMS } from './fvgRule.mjs';

const SPAN = 4 * 3600_000;

function emaSeries(v, p) {
  if (!v.length) return [];
  const k = 2 / (p + 1);
  const o = [v[0]];
  for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k));
  return o;
}

function trendAt(f, s, i, px) {
  const a = f[i], b = s[i];
  if (a == null || b == null) return 'flat';
  const sep = ((a - b) / b) * 100;
  if (sep > 0.15 && px >= b) return 'up';
  if (sep < -0.15 && px <= b) return 'down';
  return 'flat';
}

function aggregate(bars, span) {
  const htf = [], htfEnd = [];
  let cur = null, curKey = null;
  for (let i = 0; i < bars.length; i++) {
    const key = Math.floor(bars[i].t / span);
    if (key !== curKey) {
      if (cur) { htf.push(cur); htfEnd.push(i - 1); }
      curKey = key;
      cur = { t: key * span, o: bars[i].o, h: bars[i].h, l: bars[i].l, c: bars[i].c };
    } else {
      cur.h = Math.max(cur.h, bars[i].h);
      cur.l = Math.min(cur.l, bars[i].l);
      cur.c = bars[i].c;
    }
  }
  if (cur) { htf.push(cur); htfEnd.push(bars.length - 1); }
  return { bars: htf, htfEnd };
}

/**
 * Сетапы, вход по которым состоялся на последних freshBars 15m барах.
 *
 * freshBars=1 — только последний бар: будильник должен звать в момент касания,
 * а не через сутки. Возвращает уровни без исхода.
 *
 * @param {string} coin
 * @param {Array<{t:number,o:number,h:number,l:number,c:number}>} bars — 15m, по возрастанию t
 * @param {{freshBars?:number}} [opts]
 */
export function findLiveSetups(coin, bars, { freshBars = 1 } = {}) {
  const { rr: RR, wait: WAIT, minw: MINW, pen: PEN } = PARAMS;
  const out = [];
  if (bars.length < 400) return out;
  const { bars: H, htfEnd } = aggregate(bars, SPAN);
  if (H.length < 80) return out;
  const hc = H.map((b) => b.c);
  const fE = emaSeries(hc, 20), sE = emaSeries(hc, 50);
  // Граница свежести: касание раньше неё уже не новость.
  const freshFrom = bars.length - Math.max(1, freshBars);

  for (let i = 52; i < H.length - 1; i++) {
    const bull = H[i - 2].h < H[i].l, bear = H[i - 2].l > H[i].h;
    if (!bull && !bear) continue;
    const t = trendAt(fE, sE, i, H[i].c);
    if (t !== (bull ? 'up' : 'down')) continue;

    const zTop = bull ? H[i].l : H[i].h;
    const zBot = bull ? H[i - 2].h : H[i - 2].l;
    const width = Math.abs(zTop - zBot);
    if (!(width > 0) || width / zTop < MINW / 100) continue;

    const start = htfEnd[i] + 1;
    const until = Math.min(htfEnd[Math.min(i + WAIT, H.length - 1)], bars.length - 1);
    if (start >= until) continue;
    const fillPx = bull ? zTop - PEN * width : zTop + PEN * width;

    // Первое касание в окне ожидания. Оно же вход — второго по этой зоне нет.
    let hit = -1;
    for (let j = start; j <= until; j++) {
      if (bull ? bars[j].l <= fillPx : bars[j].h >= fillPx) { hit = j; break; }
    }
    if (hit < 0 || hit < freshFrom) continue;

    const entry = fillPx, stop = zBot;
    if (bull ? entry <= stop : entry >= stop) continue;
    const risk = Math.abs(entry - stop);
    const tgt = bull ? entry + RR * risk : entry - RR * risk;

    out.push({
      coin,
      side: bull ? 'LONG' : 'SHORT',
      zoneT: H[i].t,
      hitT: bars[hit].t,
      zTop, zBot, entry, stop, tgt,
      zoneWidthPct: (width / zTop) * 100,
      stopDistPct: (risk / entry) * 100,
    });
  }
  return out;
}
