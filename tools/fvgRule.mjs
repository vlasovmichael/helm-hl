// ─────────────────────────────────────────────────────────────────────────────
//  Правило fvg-wide-retest-4h — ЕДИНСТВЕННЫЙ источник истины.
//  Зафиксировано при предзаявлении 28.08.2026. Менять параметры нельзя:
//  реестр гипотез ссылается на эти значения, любая правка = новая гипотеза.
// ─────────────────────────────────────────────────────────────────────────────
export const PARAMS = Object.freeze({
  tf: '4h', rr: 2, wait: 20, maxh: 96, minw: 1.6, pen: 0.15, rtPct: 0.10,
});
const SPAN = 4 * 3600_000;

function emaSeries(v, p) { if (!v.length) return []; const k = 2 / (p + 1); const o = [v[0]];
  for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k)); return o; }
function trendAt(f, s, i, px) { const a = f[i], b = s[i]; if (a == null || b == null) return 'flat';
  const sep = ((a - b) / b) * 100;
  if (sep > 0.15 && px >= b) return 'up'; if (sep < -0.15 && px <= b) return 'down'; return 'flat'; }
function aggregate(bars, span) {
  const htf = [], htfEnd = []; let cur = null, curKey = null;
  for (let i = 0; i < bars.length; i++) {
    const key = Math.floor(bars[i].t / span);
    if (key !== curKey) { if (cur) { htf.push(cur); htfEnd.push(i - 1); }
      curKey = key; cur = { t: key * span, o: bars[i].o, h: bars[i].h, l: bars[i].l, c: bars[i].c }; }
    else { cur.h = Math.max(cur.h, bars[i].h); cur.l = Math.min(cur.l, bars[i].l); cur.c = bars[i].c; }
  }
  if (cur) { htf.push(cur); htfEnd.push(bars.length - 1); }
  return { bars: htf, htfEnd };
}

/**
 * Сделки правила по 15m барам одной монеты.
 * Возвращает ТОЛЬКО завершённые сделки (стоп/цель/таймаут внутри имеющихся данных):
 * незакрытая сделка не имеет исхода и в форвард-журнал попасть не должна.
 */
export function findTrades(coin, bars, { rtPct = PARAMS.rtPct } = {}) {
  const { rr: RR, wait: WAIT, maxh: MAXH, minw: MINW, pen: PEN } = PARAMS;
  const out = [];
  if (bars.length < 400) return out;
  const { bars: H, htfEnd } = aggregate(bars, SPAN);
  if (H.length < 80) return out;
  const hc = H.map((b) => b.c);
  const fE = emaSeries(hc, 20), sE = emaSeries(hc, 50);
  let cooldownUntil = -1;

  for (let i = 52; i < H.length - 1; i++) {
    const bull = H[i - 2].h < H[i].l, bear = H[i - 2].l > H[i].h;
    if (!bull && !bear) continue;
    const side = bull ? 'LONG' : 'SHORT';
    const t = trendAt(fE, sE, i, H[i].c);
    if (t !== (bull ? 'up' : 'down')) continue;

    const zTop = bull ? H[i].l : H[i].h;
    const zBot = bull ? H[i - 2].h : H[i - 2].l;
    const width = Math.abs(zTop - zBot);
    if (!(width > 0) || width / zTop < MINW / 100) continue;

    const start = htfEnd[i] + 1, until = Math.min(htfEnd[Math.min(i + WAIT, H.length - 1)], bars.length - 1);
    if (start >= until) continue;
    const fillPx = bull ? zTop - PEN * width : zTop + PEN * width;
    let hit = -1;
    for (let j = start; j <= until; j++) {
      if (bull ? bars[j].l <= fillPx : bars[j].h >= fillPx) { hit = j; break; }
    }
    if (hit < 0 || hit <= cooldownUntil) continue;

    const entry = fillPx, stop = zBot;
    if (bull ? entry <= stop : entry >= stop) continue;
    const risk = Math.abs(entry - stop);
    const tgt = bull ? entry + RR * risk : entry - RR * risk;

    // исход: first-touch; при неоднозначном баре засчитываем стоп (пессимистично)
    let r = null, why = null, held = 0;
    const last = Math.min(hit + MAXH, bars.length - 1);
    for (let j = hit; j <= last; j++) {
      const hitStop = bull ? bars[j].l <= stop : bars[j].h >= stop;
      const hitTgt  = bull ? bars[j].h >= tgt  : bars[j].l <= tgt;
      if (hitStop) { r = -1; why = 'stop'; held = j - hit; break; }
      if (hitTgt)  { r = RR; why = 'target'; held = j - hit; break; }
    }
    if (r == null) {
      if (last < hit + MAXH) continue;                 // ещё не закрылась — не пишем
      const d = bull ? bars[last].c - entry : entry - bars[last].c;
      r = d / risk; why = 'timeout'; held = last - hit;
    }
    out.push({ coin, entryT: bars[hit].t, side, entry, stop, tgt,
      widthPct: (risk / entry) * 100, r, rNet: r - (rtPct / 100) * entry / risk, why, held });
    cooldownUntil = hit + 8;
  }
  return out;
}
