// ─────────────────────────────────────────────────
//  TP-сетка — цель лесенкой вместо одной лимитки
// ─────────────────────────────────────────────────
// Забирать лимитками и не всю позу одной ценой. Выигрыш мейкера — не 3 бп
// комиссии, а медиана ~16 бп СПРЕДА: единственный отток, который снимается без
// всякого эджа.
//
// Сетка — НЕ трейл и не замена цели: те же reduce-only лимитки, только цель
// разложена на ступени. Каждая исполняется мейкером сама, живой тик не нужен.
//
// ⚠️ Цена этого: ближняя ступень срезает правый хвост — сделка, которая доехала
// бы до 1.25R всем объёмом, довозит только остаток. Взамен растёт доля сделок,
// где хоть что-то забрано. Это ОБМЕН с неизвестным знаком, поэтому выключено по
// умолчанию (ADOPT_TP_GRID пустой) и заведено отдельной гипотезой.
//
// Чистые функции: без сети, БД и config.

/**
 * Разбор спецификации сетки из строки.
 *
 * Два формата, в одной спеке не смешиваются:
 * - `доля@R` — ход в долях стопа: `0.5@1.0` = половину на 1R. Стоп плавает по
 *   ATR, значит плавает и процент хода;
 * - `доля@N%` — ход в процентах от входа: `0.5@1%` = половину на +1% всегда,
 *   независимо от стопа и монеты.
 *
 * Доли считаются от ИСХОДНОГО размера позиции и в сумме обязаны быть < 1:
 * сетка, снимающая всё, — это просто цель по частям, и остатка под трейл не
 * останется. Такую спецификацию отвергаем, а не подрезаем молча.
 *
 * @param {string} spec
 * @returns {{legs: Array<{frac:number, r?:number, pct?:number}>}|{error:string}}
 */
export function parseTpGrid(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) return { legs: [] };

  const legs = [];
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const m = /^([0-9.]+)@([0-9.]+)(%?)$/.exec(piece);
    if (!m) return { error: `ступень "${piece}" не в формате доля@R или доля@N%` };
    const frac = Number(m[1]);
    const dist = Number(m[2]);
    if (!(frac > 0) || !(frac < 1)) return { error: `доля в "${piece}" должна быть в (0, 1)` };
    if (!(dist > 0)) return { error: `ход в "${piece}" должен быть > 0` };
    legs.push(m[3] === '%' ? { frac, pct: dist } : { frac, r: dist });
  }

  // 🚨 Не смешивать R и проценты в одной спеке: до подхвата позиции дистанция
  // стопа неизвестна, ступени несравнимы и не раскладываются по возрастанию.
  const pctCount = legs.filter((l) => l.pct != null).length;
  if (pctCount > 0 && pctCount < legs.length) {
    return { error: 'в одной спеке либо все ступени в R, либо все в процентах' };
  }

  const total = legs.reduce((a, l) => a + l.frac, 0);
  if (total >= 1) {
    return { error: `сумма долей ${total.toFixed(2)} ≥ 1 — под остаток ничего не остаётся` };
  }
  // Ступени по возрастанию хода: ближняя к рынку исполнится первой, и порядок
  // в логе должен совпадать с порядком в жизни.
  legs.sort((a, b) => (a.pct ?? a.r) - (b.pct ?? b.r));
  return { legs };
}

/** Подпись ступени: «1%» или «1.5R». Ею же ступени различаются между собой. */
export function rungLabel(leg) {
  return leg.pct != null ? `${leg.pct}%` : `${leg.r}R`;
}

/**
 * Цены и размеры ступеней для конкретной позиции.
 *
 * @param {object} p
 * @param {Array<{frac:number,r?:number,pct?:number}>} p.legs — из parseTpGrid
 * @param {number} p.entry
 * @param {number} p.stopDistPct — дистанция вход→стоп в % (это и есть 1R)
 * @param {boolean} p.isShort
 * @param {number} p.sizeSz — размер позиции в КОНТРАКТАХ
 * @param {number} [p.minSz=0] — минимальный размер ордера в контрактах
 * @param {(n:number)=>number} [p.roundSz] — округление размера под szDecimals
 * @returns {Array<{px:number, sz:number, r:number|null, pct:number|null,
 *                  label:string}>} — ступени, ближняя первой
 */
export function buildTpGrid({
  legs,
  entry,
  stopDistPct,
  isShort,
  sizeSz,
  minSz = 0,
  roundSz = (n) => n,
}) {
  if (!Array.isArray(legs) || legs.length === 0) return [];
  if (!(entry > 0) || !(stopDistPct > 0) || !(sizeSz > 0)) return [];

  const out = [];
  let allocated = 0;
  for (const leg of legs) {
    const distPct = leg.pct ?? stopDistPct * leg.r;
    const px = isShort ? entry * (1 - distPct / 100) : entry * (1 + distPct / 100);
    const sz = roundSz(sizeSz * leg.frac);
    // Ступень мельче минимального ордера биржи — пропускаем её целиком, а не
    // округляем вверх: иначе на мелком депо сетка съедала бы больше, чем задано.
    if (!(sz > 0) || sz < minSz) continue;
    // Защита от переаллокации на округлениях: суммарно ступени не должны
    // претендовать больше, чем есть позиции.
    if (allocated + sz >= sizeSz) break;
    allocated += sz;
    out.push({ px, sz, r: leg.r ?? null, pct: leg.pct ?? null, label: rungLabel(leg) });
  }
  return out;
}

/** Остаток позиции под обычную цель/трейл после всех ступеней сетки. */
export function gridRemainder(sizeSz, grid) {
  const used = (grid || []).reduce((a, g) => a + g.sz, 0);
  const rest = sizeSz - used;
  return rest > 0 ? rest : 0;
}

/**
 * Нотионал позиции, при котором встают ВСЕ ступени спецификации.
 * В минимум ордера первой упирается самая мелкая доля — она и задаёт порог.
 *
 * @param {Array<{frac:number}>} legs — из parseTpGrid
 * @param {number} minOrderUsd — минимальный ордер биржи
 * @returns {number|null} null, если сетки нет или минимум задан мусором
 */
export function gridMinNotionalUsd(legs, minOrderUsd) {
  if (!Array.isArray(legs) || legs.length === 0) return null;
  if (!Number.isFinite(minOrderUsd) || minOrderUsd <= 0) return null;
  const minFrac = Math.min(...legs.map((l) => l.frac));
  if (!(minFrac > 0)) return null;
  return minOrderUsd / minFrac;
}
