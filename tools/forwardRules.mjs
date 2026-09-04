// ─────────────────────────────────────────────────────────────────────────────
// Правила трёх форвард-гипотез, предзаявленных.
//  ЕДИНСТВЕННЫЙ источник истины. Менять параметры нельзя: реестр гипотез
//  ссылается на эти значения, любая правка = новая гипотеза, а не эта же.
//
//  Общее для всех трёх (следствия из уже оплаченных ошибок):
//   · стоп ШИРОКИЙ по построению. Три независимых замера (FVG-разрез по ширине,
//     MTF-фильтр, LuxAlgo) показали одно: узкий стоп проигрывает КОМИССИИ, а не
//     рынку. Издержки в R = стоимость круга / ширина стопа, и на узком стопе
//     они съедают любой сигнал;
//   · сторона симметрична. Всё, что умирало раньше, умирало одинаково: плюс
//     сидел в одной клетке (лонг в растущем рынке) и оказывался бетой по BTC.
//     Поэтому каждое правило обязано работать в обе стороны;
//   · режим BTC пишется в момент входа — потом его не восстановить.
// ─────────────────────────────────────────────────────────────────────────────

const H4 = 4 * 3600_000;
const M15 = 15 * 60_000;

// ── общие помощники ─────────────────────────────────────────────────────────

function ema(v, p) {
  if (!v.length) return [];
  const k = 2 / (p + 1);
  const o = [v[0]];
  for (let i = 1; i < v.length; i++) o.push(v[i] * k + o[i - 1] * (1 - k));
  return o;
}

/** 15m бары → бары периода span. htfEnd[i] — индекс последнего 15m бара в i-м HTF-баре. */
function aggregate(bars, span) {
  const out = [], htfEnd = [];
  let cur = null, curKey = null;
  for (let i = 0; i < bars.length; i++) {
    const key = Math.floor(bars[i].t / span);
    if (key !== curKey) {
      if (cur) { out.push(cur); htfEnd.push(i - 1); }
      curKey = key;
      cur = { t: key * span, o: bars[i].o, h: bars[i].h, l: bars[i].l, c: bars[i].c };
    } else {
      cur.h = Math.max(cur.h, bars[i].h);
      cur.l = Math.min(cur.l, bars[i].l);
      cur.c = bars[i].c;
    }
  }
  if (cur) { out.push(cur); htfEnd.push(bars.length - 1); }
  return { bars: out, htfEnd };
}

/**
 * Исход сделки по 15m барам: что тронуто первым — стоп или цель.
 * При неоднозначном баре (задет и стоп, и цель) засчитывается СТОП —
 * пессимистично и одинаково для всех правил, чтобы порядок внутри бара
 * не мог подарить эджа, которого нет.
 */
function resolve(bars, from, isLong, entry, stop, tgt, maxBars) {
  const risk = Math.abs(entry - stop);
  const last = Math.min(from + maxBars, bars.length - 1);
  for (let j = from; j <= last; j++) {
    const hitStop = isLong ? bars[j].l <= stop : bars[j].h >= stop;
    const hitTgt = isLong ? bars[j].h >= tgt : bars[j].l <= tgt;
    if (hitStop) return { r: -1, why: 'stop', held: j - from };
    if (hitTgt) return { r: Math.abs(tgt - entry) / risk, why: 'target', held: j - from };
  }
  if (last < from + maxBars) return null;          // не закрылась — не записываем
  const d = isLong ? bars[last].c - entry : entry - bars[last].c;
  return { r: d / risk, why: 'timeout', held: last - from };
}

/** Издержки круга в R. rtPct — стоимость круга в % цены (тейкер туда-обратно). */
const netR = (r, rtPct, entry, risk) => r - (rtPct / 100) * entry / risk;

// ── Защита от вырожденного стопа ────────────────────────────────────────────
// НЕ параметр гипотезы: замороженные PARAMS не тронуты, правило не меняет того,
// ЧТО измеряет. Это починка прибора.
//
// 🚨 На плоских участках ATR ≈ 0, а издержки в R = стоимость круга / ширина
// стопа: при risk → 0 одна сделка даёт десятки тысяч R и делает журнал
// нечитаемым целиком.
//
// Порог экономический, а не подобранный под результат: стоп уже стоимости
// круга бессмысленен по построению (издержки съедают ≥1R ещё до движения), и
// вдвое-уже — тем более. Такие входы не торгуемы ни при каком исходе.
const MIN_RISK_OVER_RT = 2;
const tradable = (entry, risk, rtPct) =>
  risk > 0 && entry > 0 && (risk / entry) * 100 >= rtPct * MIN_RISK_OVER_RT;

// ═════════════════════════════════════════════════════════════════════════════
//  H1 · wide-stop-premium-4h
// ═════════════════════════════════════════════════════════════════════════════
// Проверяет не сетап, а ПРИНЦИП: на одном и том же входе широкий стоп бьёт
// узкий. Сигнал взят нарочно банальный и публичный — откат к EMA50 по тренду
// EMA20/50 на 4h, — чтобы проверялась именно ширина, а не хитрость входа.
//
// Схема ПАРНАЯ: с каждого входа снимаются ДВЕ сделки, отличающиеся только
// множителем стопа (0.5×ATR и 1.5×ATR), и сравниваются между собой. Так
// задумано по двум причинам, обе выяснены при оценке частоты 31.08:
//   · корзины по абсолютному порогу не работают — ATR×1.5 на крипте почти
//     всегда шире 1.6%, «узкая» корзина оказалась пустой (897 против 0);
//   · сам сигнал перекошен (LONG к SHORT как 8:1), то есть содержит бету по
//     рынку. В ПАРНОЙ разнице бета сокращается: обе ноги входят в один момент
//     на одной монете в одну сторону, и различает их только ширина стопа.
// Единица наблюдения — пара, величина — разница нетто-R (широкая минус узкая).
export const WIDE_STOP = Object.freeze({
  id: 'wide-stop-premium-4h',
  tf: '4h', rr: 2, maxh: 96, rtPct: 0.10,
  atrPeriod: 14, multWide: 1.5, multNarrow: 0.5,   // две ноги одной пары
  touchPct: 0.3,                     // «откат к EMA50» = цена подошла ближе 0.3%
});

function atrSeries(H, p) {
  const tr = [0];
  for (let i = 1; i < H.length; i++) {
    tr.push(Math.max(H[i].h - H[i].l, Math.abs(H[i].h - H[i - 1].c), Math.abs(H[i].l - H[i - 1].c)));
  }
  return ema(tr, p);
}

export function findWideStop(coin, bars) {
  const P = WIDE_STOP;
  const out = [];
  if (bars.length < 400) return out;
  const { bars: H, htfEnd } = aggregate(bars, H4);
  if (H.length < 80) return out;
  const c = H.map((b) => b.c);
  const f = ema(c, 20), s = ema(c, 50), a = atrSeries(H, P.atrPeriod);
  let cooldownUntil = -1;

  for (let i = 60; i < H.length - 1; i++) {
    const sep = ((f[i] - s[i]) / s[i]) * 100;
    const up = sep > 0.15, down = sep < -0.15;
    if (!up && !down) continue;
    // Откат: бар подошёл к EMA50 ближе touchPct, но не закрылся по ту сторону —
    // тренд ещё жив, а цена уже вернулась к средней.
    const near = up
      ? H[i].l <= s[i] * (1 + P.touchPct / 100) && H[i].c > s[i]
      : H[i].h >= s[i] * (1 - P.touchPct / 100) && H[i].c < s[i];
    if (!near) continue;

    const start = htfEnd[i] + 1;
    if (start >= bars.length || start <= cooldownUntil) continue;
    const entry = bars[start].o;
    const atrV = a[i];
    if (!(atrV > 0)) continue;

    // Две ноги одного входа. Пара засчитывается только если ОБЕ закрылись:
    // половина пары ничего не сравнивает.
    const leg = (mult) => {
      const risk = atrV * mult;
      if (!tradable(entry, risk, P.rtPct)) return null;
      const stop = up ? entry - risk : entry + risk;
      const tgt = up ? entry + P.rr * risk : entry - P.rr * risk;
      const res = resolve(bars, start, up, entry, stop, tgt, P.maxh);
      if (!res) return null;
      return {
        riskPct: (risk / entry) * 100, stop, tgt,
        r: res.r, rNet: netR(res.r, P.rtPct, entry, risk), why: res.why, held: res.held,
      };
    };
    const wide = leg(P.multWide), narrow = leg(P.multNarrow);
    if (!wide || !narrow) continue;

    out.push({
      coin, entryT: bars[start].t, side: up ? 'LONG' : 'SHORT', entry,
      wide, narrow,
      // Величина гипотезы: насколько широкий стоп лучше узкого на ЭТОМ входе.
      diffNet: wide.rNet - narrow.rNet,
    });
    cooldownUntil = start + 8;
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
//  H2 · session-open-reversal
// ═════════════════════════════════════════════════════════════════════════════
// Единственный класс данных, ещё не выпотрошенный на этом проекте, — тот, что
// НЕ является функцией цены. OI и funding уже мертвы, стакан в очереди. Здесь
// таким входом служит КАЛЕНДАРЬ: час суток задан извне рынка.
//
// Гипотеза: движение, накопленное в тихую азиатскую сессию (00:00–07:00 UTC),
// частично разворачивается на приходе европейской ликвидности (07:00 UTC).
// Ход азиатской сессии сам задаёт ширину стопа, поэтому фильтр по минимальному
// ходу обязателен — иначе стоп окажется узким и правило умрёт от комиссии.
//
// 🚨 ЕДИНИЦА НАБЛЮДЕНИЯ — ДЕНЬ, НЕ СДЕЛКА. Замер частоты 31.08 дал ~90 сделок в
// сутки, и все они входят В ОДИН И ТОТ ЖЕ МОМЕНТ на разных монетах. Считать их
// независимыми — ровно та ошибка, на которой наивный CI в MTF-замере соврал в
// 11 раз. Поэтому в реестре порог задан в ДНЯХ, а оценка идёт по дневным
// средним: сколько бы монет ни сработало, день даёт одно наблюдение.
export const SESSION_REV = Object.freeze({
  id: 'session-open-reversal',
  asiaStartUTC: 0, asiaEndUTC: 7, rr: 1.5, maxh: 32,   // 32 бара 15m = 8ч
  minMovePct: 1.2,          // ход азиатской сессии, ниже которого не входим
  stopBuffer: 0.25,         // стоп за экстремум сессии + 25% её хода
  rtPct: 0.10,
});

export function findSessionReversal(coin, bars) {
  const P = SESSION_REV;
  const out = [];
  if (bars.length < 200) return out;
  const byDay = new Map();
  for (let i = 0; i < bars.length; i++) {
    const d = new Date(bars[i].t);
    if (d.getUTCHours() < P.asiaStartUTC || d.getUTCHours() >= P.asiaEndUTC) continue;
    const key = Math.floor(bars[i].t / 86400_000);
    let a = byDay.get(key);
    if (!a) byDay.set(key, (a = []));
    a.push(i);
  }
  for (const [key, idx] of byDay) {
    if (idx.length < 24) continue;                    // сессия неполная — пропуск
    const first = bars[idx[0]], lastI = idx[idx.length - 1];
    let hi = -Infinity, lo = Infinity;
    for (const i of idx) { hi = Math.max(hi, bars[i].h); lo = Math.min(lo, bars[i].l); }
    const movePct = ((bars[lastI].c - first.o) / first.o) * 100;
    if (Math.abs(movePct) < P.minMovePct) continue;

    // Вход на первом баре после 07:00 UTC, против хода сессии.
    const start = lastI + 1;
    if (start >= bars.length) continue;
    const openT = (key + 1) * 0 + bars[start].t;      // t первого бара после сессии
    if (new Date(openT).getUTCHours() !== P.asiaEndUTC) continue;   // дыра в данных
    const isLong = movePct < 0;
    const entry = bars[start].o;
    const range = hi - lo;
    const stop = isLong ? lo - P.stopBuffer * range : hi + P.stopBuffer * range;
    const risk = Math.abs(entry - stop);
    if (!tradable(entry, risk, P.rtPct)) continue;
    const tgt = isLong ? entry + P.rr * risk : entry - P.rr * risk;

    const res = resolve(bars, start, isLong, entry, stop, tgt, P.maxh);
    if (!res) continue;
    out.push({
      coin, entryT: bars[start].t, side: isLong ? 'LONG' : 'SHORT',
      entry, stop, tgt, riskPct: (risk / entry) * 100, sessionMovePct: movePct,
      r: res.r, rNet: netR(res.r, P.rtPct, entry, risk), why: res.why, held: res.held,
    });
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
//  H3 · squeeze-expansion-4h
// ═════════════════════════════════════════════════════════════════════════════
// Волатильность возвращается к среднему надёжнее, чем цена: это одно из немногих
// свойств рынка, переживших проверку в академической литературе. Гипотеза берёт
// именно его, а не предсказание направления: после сжатия диапазона следующий
// выход из него даёт ход больше обычного.
//
// Направление не угадывается — оно берётся у самого пробоя. Стоп за
// противоположный край сжатого диапазона: по построению он тем шире, чем шире
// был диапазон, и правило само себя защищает от узкого стопа.
export const SQUEEZE = Object.freeze({
  id: 'squeeze-expansion-4h',
  tf: '4h', lookback: 20, pct: 0.25,   // диапазон в нижней четверти своей истории
  rr: 2, maxh: 96, minRangePct: 1.5, rtPct: 0.10,
});

export function findSqueeze(coin, bars) {
  const P = SQUEEZE;
  const out = [];
  if (bars.length < 400) return out;
  const { bars: H, htfEnd } = aggregate(bars, H4);
  if (H.length < P.lookback + 40) return out;
  let cooldownUntil = -1;

  for (let i = P.lookback + 20; i < H.length - 1; i++) {
    // Диапазон последних lookback баров и его место в собственной истории.
    const win = H.slice(i - P.lookback + 1, i + 1);
    const hi = Math.max(...win.map((b) => b.h));
    const lo = Math.min(...win.map((b) => b.l));
    const range = hi - lo;
    const rangePct = (range / H[i].c) * 100;
    if (!(range > 0) || rangePct < P.minRangePct) continue;

    // Сравниваем с распределением такого же диапазона на 40 барах назад.
    const hist = [];
    for (let j = i - 40; j < i; j++) {
      if (j - P.lookback + 1 < 0) continue;
      const w = H.slice(j - P.lookback + 1, j + 1);
      hist.push(Math.max(...w.map((b) => b.h)) - Math.min(...w.map((b) => b.l)));
    }
    if (hist.length < 20) continue;
    hist.sort((a, b) => a - b);
    const cut = hist[Math.floor(hist.length * P.pct)];
    if (range > cut) continue;                        // сжатия нет

    // Пробой края диапазона на следующем 4h баре — направление берём у него.
    const nxt = H[i + 1];
    const brokeUp = nxt.h > hi, brokeDn = nxt.l < lo;
    if (brokeUp === brokeDn) continue;                // оба или ни одного — пропуск
    const start = htfEnd[i] + 1;
    if (start >= bars.length || start <= cooldownUntil) continue;

    const isLong = brokeUp;
    const entry = isLong ? hi : lo;                   // вход по касанию края
    let hit = -1;
    const until = Math.min(htfEnd[i + 1], bars.length - 1);
    for (let j = start; j <= until; j++) {
      if (isLong ? bars[j].h >= entry : bars[j].l <= entry) { hit = j; break; }
    }
    if (hit < 0) continue;
    const stop = isLong ? lo : hi;                    // за противоположный край
    const risk = Math.abs(entry - stop);
    if (!tradable(entry, risk, P.rtPct)) continue;
    const tgt = isLong ? entry + P.rr * risk : entry - P.rr * risk;

    const res = resolve(bars, hit, isLong, entry, stop, tgt, P.maxh);
    if (!res) continue;
    out.push({
      coin, entryT: bars[hit].t, side: isLong ? 'LONG' : 'SHORT',
      entry, stop, tgt, riskPct: (risk / entry) * 100, rangePct,
      r: res.r, rNet: netR(res.r, P.rtPct, entry, risk), why: res.why, held: res.held,
    });
    cooldownUntil = hit + 8;
  }
  return out;
}

export const RULES = Object.freeze([
  { id: WIDE_STOP.id, params: WIDE_STOP, find: findWideStop },
  { id: SESSION_REV.id, params: SESSION_REV, find: findSessionReversal },
  { id: SQUEEZE.id, params: SQUEEZE, find: findSqueeze },
]);
