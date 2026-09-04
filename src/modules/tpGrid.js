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
 * Формат: `доля@R, доля@R, …` — «какую часть позиции снять на каком ходе в R».
 * Пример: `0.5@1.0, 0.3@1.5` — половину на 1R, ещё треть на 1.5R, остаток
 * (20%) остаётся под обычную цель/трейл.
 *
 * Доли считаются от ИСХОДНОГО размера позиции и в сумме обязаны быть < 1:
 * сетка, снимающая всё, — это просто цель по частям, и остатка под трейл не
 * останется. Такую спецификацию отвергаем, а не подрезаем молча.
 *
 * @param {string} spec
 * @returns {{legs: Array<{frac:number, r:number}>}|{error:string}}
 */
export function parseTpGrid(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) return { legs: [] };

  const legs = [];
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    const m = /^([0-9.]+)@([0-9.]+)$/.exec(piece);
    if (!m) return { error: `ступень "${piece}" не в формате доля@R` };
    const frac = Number(m[1]);
    const r = Number(m[2]);
    if (!(frac > 0) || !(frac < 1)) return { error: `доля в "${piece}" должна быть в (0, 1)` };
    if (!(r > 0)) return { error: `R в "${piece}" должен быть > 0` };
    legs.push({ frac, r });
  }

  const total = legs.reduce((a, l) => a + l.frac, 0);
  if (total >= 1) {
    return { error: `сумма долей ${total.toFixed(2)} ≥ 1 — под остаток ничего не остаётся` };
  }
  // Ступени по возрастанию R: ближняя к рынку исполнится первой, и порядок в
  // логе должен совпадать с порядком в жизни.
  legs.sort((a, b) => a.r - b.r);
  return { legs };
}

/**
 * Цены и размеры ступеней для конкретной позиции.
 *
 * @param {object} p
 * @param {Array<{frac:number,r:number}>} p.legs — из parseTpGrid
 * @param {number} p.entry
 * @param {number} p.stopDistPct — дистанция вход→стоп в % (это и есть 1R)
 * @param {boolean} p.isShort
 * @param {number} p.sizeSz — размер позиции в КОНТРАКТАХ
 * @param {number} [p.minSz=0] — минимальный размер ордера в контрактах
 * @param {(n:number)=>number} [p.roundSz] — округление размера под szDecimals
 * @returns {Array<{px:number, sz:number, r:number}>} — ступени, ближняя первой
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
    const distPct = stopDistPct * leg.r;
    const px = isShort ? entry * (1 - distPct / 100) : entry * (1 + distPct / 100);
    const sz = roundSz(sizeSz * leg.frac);
    // Ступень мельче минимального ордера биржи — пропускаем её целиком, а не
    // округляем вверх: иначе на мелком депо сетка съедала бы больше, чем задано.
    if (!(sz > 0) || sz < minSz) continue;
    // Защита от переаллокации на округлениях: суммарно ступени не должны
    // претендовать больше, чем есть позиции.
    if (allocated + sz >= sizeSz) break;
    allocated += sz;
    out.push({ px, sz, r: leg.r });
  }
  return out;
}

/** Остаток позиции под обычную цель/трейл после всех ступеней сетки. */
export function gridRemainder(sizeSz, grid) {
  const used = (grid || []).reduce((a, g) => a + g.sz, 0);
  const rest = sizeSz - used;
  return rest > 0 ? rest : 0;
}
