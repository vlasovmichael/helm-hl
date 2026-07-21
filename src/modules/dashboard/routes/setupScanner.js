// ─────────────────────────────────────────────────
//  Setup Scanner — конвергентный радар (JSON для карточки на /oi.html)
// ─────────────────────────────────────────────────
// Порт «score N/4»-радара со старого Python-сервиса (192.168.0.108:8081) на
// данные, которые бот УЖЕ копит в setup_snapshots. Ничего нового не собираем —
// это надстройка-презентация. Рендерит карточку oi.js по этому payload.
//
// ⚠️ Радар, а не сигнал: показывает, сколько из 4 накопительных признаков
// сошлись. Направление/тайминг решает оператор. Forward-эдж конвергенции не доказан.

import { getSetupScannerRows } from '../../../core/database.js';
import { scoreAndRank } from '../../setupScannerScore.js';

const fmtPctInt = (v) =>
  v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${Math.round(v)}%`;
const fmtBasis = (premium) =>
  premium == null || !Number.isFinite(premium)
    ? '—'
    : `${premium >= 0 ? '+' : ''}${(premium * 100).toFixed(2)}%`;
const fmtVol = (ratio) =>
  ratio == null || !Number.isFinite(ratio) ? '—' : `${ratio.toFixed(2)}x`;
function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

// cls: hit=сработал · miss=нет · warm=окно ещё копит (в score не идёт)
const cls = (hit, warm) => (warm ? 'warm' : hit ? 'hit' : 'miss');

function toDisplayRow(r) {
  const s = r.setup;
  const oi = r.oi7d;
  const vr = r.volRegime;
  return {
    coin: r.coin,
    score: s.score,
    dir: s.dir,
    funding: {
      // Всегда показываем ТЕКУЩИЙ фандинг (последний снапшот) — чтобы живое
      // значение было видно сразу, даже пока 24ч-окно ещё копит. Цвет ячейки =
      // вердикт персистентности за 24ч: hit(зел)/miss(серый)/warm(синий, не в score).
      text: fmtPctInt(r.fundingApy),
      cls: cls(s.hits.funding, s.warm.funding),
    },
    oiRamp: {
      text: s.warm.oiRamp
        ? 'warm'
        : oi && oi.deltaOi != null
          ? `${fmtPctInt(oi.deltaOi * 100)} / px${fmtPctInt((oi.deltaPx ?? 0) * 100)}`
          : '—',
      cls: cls(s.hits.oiRamp, s.warm.oiRamp),
    },
    basis: { text: fmtBasis(r.premium), cls: cls(s.hits.basis, false) },
    vol: {
      text: s.warm.vol ? 'warm' : fmtVol(vr?.ratio),
      cls: cls(s.hits.vol, s.warm.vol),
    },
    vlm: fmtUsd(r.vol24hUsd),
  };
}

/** Собирает payload радара: meta + отсортированные по score строки. */
export function buildScannerPayload() {
  const rows = getSetupScannerRows();
  const ranked = scoreAndRank(rows);
  const now = Date.now();
  let lastTs = 0;
  let spanH = 0;
  for (const r of rows) {
    if (r.ts > lastTs) lastTs = r.ts;
    for (const a of [r.fundingPersist?.ageHours, r.oi7d?.ageHours, r.volRegime?.ageHours]) {
      if (Number.isFinite(a) && a > spanH) spanH = a;
    }
  }
  const display = ranked.map(toDisplayRow);
  const topRow = ranked.find((r) => r.setup.score > 0) || null;
  return {
    generatedAt: now,
    coins: ranked.length,
    dataSpanHours: spanH,
    updatedAgoSec: lastTs ? Math.round((now - lastTs) / 1000) : null,
    top: topRow
      ? {
          coin: topRow.coin,
          dir: topRow.setup.dir,
          score: topRow.setup.score,
          // Сырьё для hero-подписи «funding …, basis …, vol …».
          funding: topRow.setup.funding24hApy ?? topRow.fundingApy ?? null,
          basis: topRow.premium ?? null,
          vol: topRow.volRegime?.ratio ?? null,
        }
      : null,
    rows: display,
  };
}

export function handleScannerApi(_req, res) {
  try {
    res.json(buildScannerPayload());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
