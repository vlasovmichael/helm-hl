// ─────────────────────────────────────────────────
//  Hot Movers — DOM-рендер таблицы (momentum + OI-режим + Setup-вердикт).
//  Чистая логика (computeMomentum/hmEntryBadge/derive*) живёт в ./momentum.js.
//  fmtTime передаётся параметром — он зависит от currentRangeHours в main.js.
// ─────────────────────────────────────────────────

import { escapeHtml } from "../utils/format.js";
import {
  computeMomentum,
  hmEntryBadge,
  deriveAccelKind,
  deriveVolKind,
} from "./momentum.js";
import {
  isActiveCoin,
  hmPosHintRow,
  getActiveCoins,
  getActivePos,
} from "../state/activeCoins.js";

const _hmPrevPrices = new Map();

export function renderHotMovers(payload, fmtTime) {
  const tbody = document.getElementById("hot-movers-tbody");
  const meta = document.getElementById("hot-movers-meta");
  if (!tbody || !meta) return;
  const signals = Array.isArray(payload?.signals) ? payload.signals : [];
  const th = payload?.thresholds || {};

  // Сортировка: по силе momentum'а (взвешенный ход по окнам + подтверждение
  // accel/vol). Едем ПО движению — ZEC-тип грайнда всплывает наверх как LONG.
  const sorted = signals
    .map((s) => {
      const windows = Array.isArray(s.windows) ? s.windows : [];
      let maxAbs = -Infinity;
      for (const w of windows) {
        if (w.spikePct != null && Math.abs(w.spikePct) > maxAbs) {
          maxAbs = Math.abs(w.spikePct);
        }
      }
      const w2 = windows.find((w) => w.mins === 2);
      const w5 = windows.find((w) => w.mins === 5);
      const mom = computeMomentum(
        windows,
        deriveAccelKind(w2, w5),
        deriveVolKind(s.volMult),
        s,
      );
      return { s, windows, maxAbs, momScore: mom.score };
    })
    .filter((x) => x.maxAbs > -Infinity)
    .sort((a, b) => b.momScore - a.momScore || b.maxAbs - a.maxAbs);

  // Открытую монету (позиция бота / ручная) всегда пиним наверх, даже если её
  // momentum не в топ-20 — оператор хочет видеть свою позицию первой (2026-06-13).
  const activeRows = sorted.filter((x) => isActiveCoin(x.s.coin));
  // …и даже если монеты ВООБЩЕ нет в сигналах сканера (затихла → выпала из
  // signals). Без этого пин-строка мигала: позиция то пропадала, то возвращалась
  // вместе с импульсом. Синтезируем минимальную строку из данных позиции —
  // momentum-ячейки будут «—», но позиция остаётся видимой (2026-06-13).
  const inSorted = new Set(activeRows.map((x) => x.s.coin));
  for (const coin of getActiveCoins()) {
    if (inSorted.has(coin)) continue;
    const p = getActivePos(coin);
    activeRows.push({
      s: { coin, price: p?.now ?? null, windows: [], volMult: null, isActive: true },
      windows: [],
      maxAbs: 0,
      momScore: 0,
    });
  }
  const restRows = sorted
    .filter((x) => !isActiveCoin(x.s.coin))
    .slice(0, Math.max(1, 20 - activeRows.length));
  const enriched = [...activeRows, ...restRows];

  const activeShown = activeRows.length;
  meta.textContent = payload?.ts
    ? `scope ${payload.universeSize} · top ${restRows.length} by momentum${activeShown ? ` · ${activeShown} open` : ""} · updated ${fmtTime(payload.ts)}`
    : "—";

  if (!enriched.length) {
    tbody.innerHTML =
      '<tr><td colspan="11" class="empty-state">Waiting for price history…</td></tr>';
    return;
  }

  const fmtPrice = (p) => {
    if (p == null) return "—";
    if (p >= 100) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    return p.toPrecision(4);
  };
  const fmtPct = (v) => {
    if (v == null) return "—";
    const sign = v >= 0 ? "+" : "";
    return `${sign}${v.toFixed(2)}%`;
  };
  // Tier+sign → CSS-класс ячейки. Использует существующие num-pos/neg-* классы
  // (зелёный/красный тинт + жирность по силе). Hunter-порог визуально виден в
  // самой Hot Movers таблице — отдельная карточка не нужна.
  const tierCellCls = (w) => {
    if (!w || w.spikePct == null) return "num-muted";
    const tier = w.tier;
    if (!tier || tier === "NEUTRAL") return "";
    const pos = w.spikePct > 0;
    if (tier === "STRONG") return pos ? "num-pos-strong" : "num-neg-strong";
    if (tier === "NORMAL") return pos ? "num-pos" : "num-neg";
    if (tier === "WEAK") return pos ? "num-pos-weak" : "num-neg-weak";
    return "";
  };
  const pctCellTiered = (w) => {
    if (!w || w.spikePct == null)
      return ['<span class="num-inline-muted">—</span>', ""];
    const v = w.spikePct;
    const arrow = v > 0 ? "▲" : v < 0 ? "▼" : "·";
    const cls = tierCellCls(w);
    const inner = cls
      ? `${arrow} ${fmtPct(v)}`
      : `<span class="${v > 0 ? "num-inline-pos" : "num-inline-neg"}">${arrow} ${fmtPct(v)}</span>`;
    return [inner, cls];
  };
  const findWin = (windows, mins) => windows.find((w) => w.mins === mins);
  const winByLabel = (windows, label) => windows.find((w) => w.label === label);

  tbody.innerHTML = enriched
    .map((x, idx) => {
      const s = x.s;
      const w2 = findWin(x.windows, 2) || winByLabel(x.windows, "2m");
      const w5 = findWin(x.windows, 5) || winByLabel(x.windows, "5m");
      const w15 = findWin(x.windows, 15) || winByLabel(x.windows, "15m");
      const trendLbl = th.trendLookbackMin ? `${th.trendLookbackMin}m` : "";
      const trendPct = s.trendPct;
      const trendInner =
        trendPct == null
          ? '<span class="num-inline-muted">—</span>'
          : `<span class="${trendPct > 0 ? "num-inline-pos" : "num-inline-neg"}">${trendPct > 0 ? "▲" : "▼"} ${fmtPct(trendPct)}</span> <span class="num-inline-muted">/ ${trendLbl}</span>`;

      // Living heatmap: тинт строки по доминирующему движению цены (как на бирже —
      // вверх зелёный, вниз красный), интенсивность по |move|. Не зависит от
      // fade-тиров, поэтому карточка «дышит» даже когда сигналов нет.
      let domMove = 0;
      for (const w of x.windows) {
        if (w.spikePct != null && Math.abs(w.spikePct) > Math.abs(domMove))
          domMove = w.spikePct;
      }
      const moveAbs = Math.abs(domMove);
      const heatLvl =
        moveAbs >= 1.5
          ? "strong"
          : moveAbs >= 0.6
            ? "mid"
            : moveAbs >= 0.1
              ? "weak"
              : "";
      const heatCls = heatLvl
        ? `${domMove > 0 ? "row-up" : "row-down"} row-heat-${heatLvl}`
        : "";

      const isOpen = s.isActive || isActiveCoin(s.coin);
      const rowCls = [isOpen ? "is-active" : "", heatCls]
        .filter(Boolean)
        .join(" ");

      // Биржевая flash-вспышка: цена выросла с прошлого рендера → зелёный,
      // упала → красный. Анимация играет один раз на новом DOM-узле.
      const prevPx = _hmPrevPrices.get(s.coin);
      let flashCls = "";
      if (prevPx != null && s.price != null && s.price !== prevPx) {
        flashCls = s.price > prevPx ? "hm-flash-up" : "hm-flash-down";
      }
      if (s.price != null) _hmPrevPrices.set(s.coin, s.price);

      const winDefs = [
        [w2, "2m"],
        [w5, "5m"],
        [w15, "15m"],
      ];
      const cells = winDefs
        .map(([w, lbl]) => {
          // У открытой монеты momentum-ячейки НЕ гасим — для позиции это и есть
          // exit-сигнал «движ ещё жив или выдыхается», единственное чего нет в
          // панели Active Position. Раньше гасили 2m/5m, но без него строка
          // активной монеты теряла весь смысл (2026-06-13).
          const [inner, cls] = pctCellTiered(w);
          const klass = ["hm-window", "r", cls].filter(Boolean).join(" ");
          return `<td class="${klass}" data-w="${lbl}">${inner}</td>`;
        })
        .join("");

      // Accel: |w2| vs линейная экстраполяция w5 (×0.4). Ratio ≥1.2 = ускорение
      // (не фейди), ≤0.6 = выдыхается (хороший момент), знаки разные = разворот.
      // accelKind/accelRatio выносим наружу — нужны для Setup-вердикта ниже.
      let accelInner = '<span class="num-inline-muted">—</span>';
      let accelCellCls = "";
      let accelKind = null; // 'up' | 'down' | 'flat' | 'rev' | null
      let accelRatio = null;
      if (w2 && w5 && w2.spikePct != null && w5.spikePct != null) {
        const a = w2.spikePct,
          b = w5.spikePct;
        if (Math.abs(b) < 0.05) {
          accelInner = '<span class="num-inline-muted">→</span>';
          accelKind = "flat";
        } else if (a > 0 !== b > 0 && Math.abs(a) > 0.2) {
          accelInner = '<span style="color:var(--accent)">↻ rev</span>';
          accelKind = "rev";
        } else {
          const expected = b * 0.4;
          const ratio = expected !== 0 ? Math.abs(a) / Math.abs(expected) : 0;
          accelRatio = ratio;
          if (ratio >= 1.2) {
            accelInner = `<span style="color:var(--red)">▲ ${ratio.toFixed(1)}×</span>`;
            accelCellCls = "num-neg-weak";
            accelKind = "up";
          } else if (ratio <= 0.6) {
            accelInner = `<span style="color:var(--green)">▼ ${ratio.toFixed(1)}×</span>`;
            accelCellCls = "num-pos-weak";
            accelKind = "down";
          } else {
            accelInner = `<span class="num-inline-muted">→ ${ratio.toFixed(1)}×</span>`;
            accelKind = "flat";
          }
        }
      }

      // Vol×: серверный multiplier (5min recent / avg 5min over hour).
      let volInner = '<span class="num-inline-muted">…</span>';
      let volCellCls = "";
      let volKind = null; // 'high' | 'mid' | 'normal' | 'thin' | null
      if (typeof s.volMult === "number" && isFinite(s.volMult)) {
        const v = s.volMult;
        let color = "var(--text-muted)";
        if (v >= 2) {
          color = "var(--red)";
          volCellCls = "num-neg-weak";
          volKind = "high";
        } else if (v >= 1.3) {
          color = "var(--orange, #f59e0b)";
          volKind = "mid";
        } else if (v <= 0.5) {
          color = "var(--green)";
          volCellCls = "num-pos-weak";
          volKind = "thin";
        } else {
          volKind = "normal";
        }
        volInner = `<span style="color:${color}">${v.toFixed(1)}×</span>`;
      } else if (s.volMult === null) {
        volInner = '<span class="num-inline-muted">—</span>';
      }

      // Setup: ОДИН сетап + причина. Режим выбирает OI (trend/fade), сила по
      // взвешенному ходу окон с подтверждением accel/vol.
      const setup = computeMomentum(x.windows, accelKind, volKind, x.s);
      const entry = hmEntryBadge(x.windows, setup.side, setup.score, setup.mode);

      // OI delta 5m — нейтральная раскраска: OI сам по себе не хорош/плох,
      // его смысл зависит от направления цены (режим выбирает Setup-вердикт).
      let oiInner = '<span class="num-inline-muted">—</span>';
      const oiCellCls = "";
      if (typeof s.oiDelta5m === "number" && isFinite(s.oiDelta5m)) {
        const v = s.oiDelta5m;
        const arrow = v > 0 ? "▲" : "▼";
        if (Math.abs(v) >= 3) {
          oiInner = `<span style="color:var(--accent);font-weight:600">${arrow} ${fmtPct(v)}</span>`;
        } else if (Math.abs(v) >= 1) {
          oiInner = `<span style="color:var(--text-muted)">${arrow} ${fmtPct(v)}</span>`;
        } else {
          oiInner = `<span class="num-inline-muted">${fmtPct(v)}</span>`;
        }
      }

      // У открытой монеты Setup-вердикт гасим — вход уже сделан, действие в подсказке.
      const setupCell = isOpen
        ? `<td class="hm-setup c" data-w="Setup"><span class="num-inline-muted">·</span></td>`
        : `<td class="hm-setup c ${setup.cls}" data-w="Setup" title="${setup.title}">${setup.label}</td>`;
      const mainRow = `<tr class="${rowCls}">
        <td>${isOpen ? "📍" : idx + 1}</td>
        <td><span class="signals-price">#${escapeHtml(s.coin)}</span>${isOpen ? '<span class="hm-active-badge">поз.</span>' : ""}</td>
        ${setupCell}
        <td class="hm-entry hm-entry-${entry.state}" data-w="Вход" title="${entry.title}"><span class="hm-entry-icon">${entry.icon}</span></td>
        <td class="hm-price-cell r ${flashCls}"><span class="signals-price">${fmtPrice(s.price)}</span></td>
        ${cells}
        <td class="r ${accelCellCls}" data-w="Acc">${accelInner}</td>
        <td class="r ${oiCellCls}" data-w="OI">${oiInner}</td>
        <td class="r" data-w="Trend">${trendInner}</td>
      </tr>`;
      // У открытой монеты под основной строкой — статус-строка с действиями
      // бота (стоп/BE/трейл/пик/ликв), без дубля % и P&L (см. Active Position).
      // Если бот ничего не делает — под-строки нет, метка живёт на самой строке.
      return isOpen ? mainRow + hmPosHintRow(s.coin) : mainRow;
    })
    .join("");
}
