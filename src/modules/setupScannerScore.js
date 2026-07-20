// ─────────────────────────────────────────────────
//  Setup Scanner — конвергентный score 0–4 (радар, НЕ сигнал)
// ─────────────────────────────────────────────────
// Порт «score N/4»-логики со старого Python-радара (192.168.0.108:8081) на
// данные, которые бот УЖЕ копит в setup_snapshots (getSetupScannerRows()).
// Ничего нового не собираем — это чистая надстройка-презентация.
//
// ⚠️ Это РАДАР, а не светофор. Показывает, сколько из 4 независимых
// «накопительных» признаков сошлись одновременно по монете. Направление и
// тайминг ставит оператор сам. Forward-эдж конвергенции НЕ доказан — цифра = контекст.
//
// 4 признака (легенда оригинала):
//   funding — |средний APR за 48ч| ≥ 50%   (толпа в перекосе)
//   OI ramp — ΔOI(7д) ≥ +50% при |Δцены| ≤ 7%  (позиции набиваются в сжатии)
//   basis   — |премия перпа к оракулу| ≥ 0.10%
//   vol     — 24ч объём / своя норма ≥ 1.5×
//
// «warm» = окно ещё копит историю → признак в score НЕ идёт (нет ложных
// срабатываний на старте). Соответствует полю { etaHours } из getSetupScannerRows.

export const FUNDING_ABS_APY = 50;   // |avg APR 48ч| ≥ 50%
export const OI_RAMP_MIN     = 0.50; // ΔOI ≥ +50%
export const OI_PX_MAX       = 0.07; // |Δцены| ≤ 7%
export const BASIS_ABS       = 0.001; // |premium| ≥ 0.10%
export const VOL_RATIO_MIN   = 1.5;  // 24ч/норма ≥ 1.5×

/**
 * Оценивает одну строку getSetupScannerRows().
 * @param {Object} row — { fundingApy, fundingPersist, oi7d, premium, volRegime, ... }
 * @returns {{
 *   score: number,
 *   dir: 'LONG'|'SHORT'|null,
 *   hits: {funding:boolean, oiRamp:boolean, basis:boolean, vol:boolean},
 *   warm: {funding:boolean, oiRamp:boolean, vol:boolean},
 *   funding48hApy: number|null,
 * }}
 */
export function scoreSetupRow(row) {
  const hits = { funding: false, oiRamp: false, basis: false, vol: false };
  const warm = { funding: false, oiRamp: false, vol: false };

  // funding — средний APR за 48ч. warm пока окно не набрало 48ч (etaHours).
  const fp = row?.fundingPersist;
  let funding48hApy = null;
  if (fp && fp.etaHours == null && fp.avgApy != null) {
    funding48hApy = fp.avgApy;
    hits.funding = Math.abs(fp.avgApy) >= FUNDING_ABS_APY;
  } else if (fp && fp.etaHours != null) {
    warm.funding = true;
  }

  // OI ramp — рост OI без хода цены. warm пока нет 7д истории.
  const oi = row?.oi7d;
  if (oi && oi.etaHours == null && oi.deltaOi != null) {
    hits.oiRamp =
      oi.deltaOi >= OI_RAMP_MIN &&
      oi.deltaPx != null &&
      Math.abs(oi.deltaPx) <= OI_PX_MAX;
  } else if (oi && oi.etaHours != null) {
    warm.oiRamp = true;
  }

  // basis — последняя премия. Готова всегда (нет окна накопления).
  if (row?.premium != null) {
    hits.basis = Math.abs(row.premium) >= BASIS_ABS;
  }

  // vol — режим объёма против 30д нормы. warm пока нет 30д истории.
  const vr = row?.volRegime;
  if (vr && vr.etaHours == null && vr.ratio != null) {
    hits.vol = vr.ratio >= VOL_RATIO_MIN;
  } else if (vr && vr.etaHours != null) {
    warm.vol = true;
  }

  const score =
    (hits.funding ? 1 : 0) +
    (hits.oiRamp ? 1 : 0) +
    (hits.basis ? 1 : 0) +
    (hits.vol ? 1 : 0);

  // Направление = фейд толпы по фандингу: толпа в шорте (funding−) → LONG,
  // толпа в лонге (funding+) → SHORT. Берём 48ч-средний, иначе last.
  const fundingForDir = funding48hApy != null ? funding48hApy : (row?.fundingApy ?? null);
  const dir = fundingForDir == null || fundingForDir === 0
    ? null
    : fundingForDir < 0 ? 'LONG' : 'SHORT';

  return { score, dir, hits, warm, funding48hApy };
}

/**
 * Скорит и сортирует все строки (score ↓, при равенстве 24ч объём ↓).
 * @param {Array<Object>} rows — getSetupScannerRows()
 * @returns {Array<Object>} rows + { setup: scoreSetupRow(...) }, отсортированы
 */
export function scoreAndRank(rows) {
  const scored = (rows || []).map((r) => ({ ...r, setup: scoreSetupRow(r) }));
  scored.sort((a, b) => {
    if (b.setup.score !== a.setup.score) return b.setup.score - a.setup.score;
    return (b.vol24hUsd ?? 0) - (a.vol24hUsd ?? 0);
  });
  return scored;
}
