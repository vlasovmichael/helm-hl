// ─────────────────────────────────────────────────
//  Hot Movers — DOM-рендер таблицы (momentum + OI-режим + Setup-вердикт).
//  Чистая логика (computeMomentum/derive*) живёт в ./momentum.js.
//  fmtTime передаётся параметром — он зависит от currentRangeHours в main.js.
//
//  Рендер идёт через keyed-реконсилер (reconcileRows): строки переживают тики,
//  поэтому цена в ячейке меняется без пересборки таблицы, при смене ранга
//  монета едет на новое место, новая — проявляется, ушедшая — гаснет.
// ─────────────────────────────────────────────────

import { escapeHtml } from "../utils/format.js";
import { tvUrl } from "../utils/links.js";
import { popArrow, bindArrowPopEnd, initChevronArrow } from "../utils/arrowPop.js";
import { icon } from "../core/icon.js";
import {
  computeMomentum,
  deriveAccelKind,
  deriveVolKind,
} from "./momentum.js";
import {
  isActiveCoin,
  hmPosHintInner,
  getActiveCoins,
  getActivePos,
} from "../state/activeCoins.js";

const _hmPrevPrices = new Map();

// Порог чипа Vol/OI: «вечеринка» = суточный оборот ПРЕВЫШАЕТ открытый интерес.
// На HL OI>Vol — норма (медиана ~3×), поэтому Vol≥OI (ратио ≥1) уже редкость и
// значит реальную движуху: монета сегодня крутится, а не залегла.
const VOL_OI_PARTY = 1;
// Компактный $ для тултипа чипа: $2.1B / $34M / $880k.
function fmtUsdShort(v) {
  if (v == null || !isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(0)}`;
}

// Setup-вердикт карточки = контекст-направление по движению (computeMomentum в
// режиме 'trend'). Continuation НЕ actionable (бэктест в минус) — единственный
// вход = под-строка fade-high-ER. Radio Trend/Fade убран 2026-06-19 (он не флипал
// ничего торгуемого после честного вердикта — см. memory smart_signals_removed).


// Line-SVG иконки колонки Enter. stroke=currentColor → цвет от .hm-entry-${state}.
// После честного вердикта (2026-06-19) для незанятой монеты состояний всего два:
//  · zone — мишень/прицел: сработал fade-high-ER, вход рядом (pulse, зелёный).
//  · none — тире: эджа нет (continuation = контекст, не сделка).
const ENTRY_ICON_SVG = {
  zone:
    '<svg class="hm-eico hm-eico-zone" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="3.4"/>' +
    '<circle class="hm-eico-dot" cx="12" cy="12" r="1.1"/>' +
    '<path d="M12 1.6v2.8M12 19.6v2.8M1.6 12h2.8M19.6 12h2.8"/></svg>',
  none:
    '<svg class="hm-eico" viewBox="0 0 24 24" fill="none" aria-hidden="true">' +
    '<path d="M8 12h8"/></svg>',
};

// Инлайн-спарклайн цены за ~20 мин (бэк отдаёт s.spark — даунсэмпл из price-
// буфера, без запросов к HL). Цвет = знак хода (last vs first); почти-флэт →
// приглушённый. preserveAspectRatio:none — линия растягивается на бокс, форма
// читается даже на 56×16. Пустой/<2 точек → "" (фронт ничего не рисует).
const SPARK_W = 44;
const SPARK_H = 14;
function sparkSvg(spark) {
  if (!Array.isArray(spark) || spark.length < 2) return "";
  let min = Infinity,
    max = -Infinity;
  for (const v of spark) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return "";
  const span = max - min || 1;
  const n = spark.length;
  const dx = (SPARK_W - 2) / (n - 1);
  const pts = spark
    .map((v, i) => {
      const x = 1 + i * dx;
      const y = 1 + (SPARK_H - 2) * (1 - (v - min) / span);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const first = spark[0];
  const last = spark[n - 1];
  const chg = first ? (last - first) / first : 0;
  const cls =
    Math.abs(chg) < 0.0005 ? "spark-flat" : last >= first ? "spark-up" : "spark-down";
  return (
    `<svg class="hm-spark ${cls}" viewBox="0 0 ${SPARK_W} ${SPARK_H}" width="${SPARK_W}" height="${SPARK_H}" ` +
    `preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`
  );
}

// Клик по ВСЕЙ строке монеты → открыть TradingView (раньше кликабельно было
// только название). Делегируем на tbody один раз. Источник url — существующая
// .hm-coin-link внутри строки (её native-клик оставляем как есть, иначе откроем
// дважды). Клики по другим ссылкам/кнопкам не перехватываем. Только строки
// монет (data-hmkey="m:…"), не под-строки позиции/fade.
function ensureRowClick(tbody) {
  if (tbody.__hmRowClick) return;
  tbody.__hmRowClick = true;
  tbody.addEventListener("click", (e) => {
    if (e.target.closest("a, button")) return; // native-элемент сам отработает
    const row = e.target.closest('tr[data-hmkey^="m:"]');
    if (!row) return;
    const link = row.querySelector(".hm-coin-link");
    if (link?.href) window.open(link.href, "_blank", "noopener");
  });
}

// Сколько монет максимум в таблице (открытые позиции — сверх лимита, всегда).
const HM_MAX_ROWS = 8;

// ── Прогресс загрузки монет: детерминантная полоска «по времени» ──
// Точного % бэкенд не шлёт (снапшот приходит целиком), поэтому полоску ведём по
// прошедшему времени относительно ОБЫЧНОЙ длительности загрузки. Длительность
// замеряем при каждом успешном старте и запоминаем (EMA в localStorage) → оценка
// уточняется под реальное окружение оператора. Допрыгивает до 100% ровно когда
// монеты приехали.
let hmLoadStart = 0;
let hmProgressRAF = null;
const HM_LOAD_KEY = "hl-hm-load-ms";

function hmLoadEstimateMs() {
  const v = parseInt(localStorage.getItem(HM_LOAD_KEY) || "0", 10);
  return Math.min(20000, Math.max(2000, v || 5000));
}
// % к текущему моменту: линейно по времени к оценке, кап 95% (последние 5%
// держим под «реально готово», чтобы полоска не врала о завершении).
function hmProgressPct() {
  if (!hmLoadStart) return 0;
  const elapsed = performance.now() - hmLoadStart;
  return Math.min(95, (elapsed / hmLoadEstimateMs()) * 100);
}
function startHmProgress() {
  if (!hmLoadStart) hmLoadStart = performance.now();
  if (hmProgressRAF) return;
  const step = () => {
    const fill = document.querySelector(".hm-status-bar-fill");
    if (!fill) {
      hmProgressRAF = null;
      return; // строка ушла (монеты приехали) — finishHmProgress() уже отработал
    }
    fill.style.width = hmProgressPct().toFixed(1) + "%";
    hmProgressRAF = requestAnimationFrame(step);
  };
  hmProgressRAF = requestAnimationFrame(step);
}
function finishHmProgress() {
  if (hmProgressRAF) {
    cancelAnimationFrame(hmProgressRAF);
    hmProgressRAF = null;
  }
  if (hmLoadStart) {
    // Запоминаем реальную длительность (EMA) для следующей оценки.
    const dur = performance.now() - hmLoadStart;
    const prev = parseInt(localStorage.getItem(HM_LOAD_KEY) || "0", 10) || dur;
    localStorage.setItem(HM_LOAD_KEY, String(Math.round(prev * 0.6 + dur * 0.4)));
    hmLoadStart = 0;
  }
}

export function renderHotMovers(payload, fmtTime) {
  const tbody = document.getElementById("hot-movers-tbody");
  const meta = document.getElementById("hot-movers-meta");
  if (!tbody || !meta) return;
  ensureRowClick(tbody);

  const signals = Array.isArray(payload?.signals) ? payload.signals : [];
  const th = payload?.thresholds || {};
  const flush = payload?.marketFlush || null;

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
        flush,
      );
      return { s, windows, maxAbs, momScore: mom.score };
    })
    .filter((x) => x.maxAbs > -Infinity)
    .sort((a, b) => b.momScore - a.momScore || b.maxAbs - a.maxAbs);

  // Открытую монету (позиция бота / ручная) всегда пиним наверх, даже если её
  // momentum не в топе — оператор хочет видеть свою позицию первой (2026-06-13).
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
  // Остальные строки: всегда добиваем таблицу до HM_MAX_ROWS топом по momentum,
  // БЕЗ отсечки по ходу. Раньше прятали WAIT/dead-flat (|ход|<0.2%) — но в тихом
  // рынке под порог проходило 3-4 монеты, и таблица показывала «top 4» + пустые
  // плейсхолдеры. Юзер хочет видеть 8 реальных монет (сильнейшие сверху, тихие
  // снизу с WAIT/—), а не 4 + дырки. sorted уже по momScore↓ (2026-06-18).
  const slots = Math.max(0, HM_MAX_ROWS - activeRows.length);
  const restRows = sorted
    .filter((x) => !isActiveCoin(x.s.coin))
    .slice(0, slots);
  const enriched = [...activeRows, ...restRows];

  const activeShown = activeRows.length;
  if (!payload?.ts) {
    meta.textContent = "—";
  } else {
    const base = `scope ${payload.universeSize} · top ${restRows.length} by momentum${activeShown ? ` · ${activeShown} open` : ""} · updated ${fmtTime(payload.ts)}`;
    if (flush?.active) {
      const sharePct = Math.round((flush.share || 0) * 100);
      const word = flush.dir === "up" ? "SQUEEZE" : "FLUSH";
      meta.innerHTML = `<span class="hm-flush-chip" title="Synchronized deleveraging across movers (${sharePct}% of top with OI down) — fade against the move = catching a knife, muted">${icon("warn")} ${word} ${sharePct}%</span> · ${escapeHtml(base)}`;
    } else {
      meta.textContent = base;
    }
  }

  // Пустых строк больше не делаем через innerHTML (это сбрасывало бы реконсилер
  // и дёргало высоту) — таблица всегда добивается плейсхолдерами до HM_MAX_ROWS
  // ниже, перед reconcileRows. При полном затишье покажем 8 пустых строк, статус
  // «тихо» виден в meta (top 0 by momentum).

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
  // Единая SVG-стрелка для всех %-колонок (2m/5m/15m/ACC/OI/TREND): треугольник
  // вверх/вниз + нейтральная риска для флэта. fill=currentColor → цвет берётся от
  // num-inline-pos/neg (зелёный/красный) или inline-color родителя, ничего не
  // дублируем. Мягкая анимация появления — в CSS (.hm-arw, уважает reduced-motion).
  // dir: >0 рост, <0 падение, 0 флэт. (2026-06-28, вместо текстовых ▲/▼/→)
  const arwSvg = (dir) => {
    if (dir > 0)
      return '<svg class="hm-arw hm-arw--up" viewBox="0 0 14 16" fill="none" aria-hidden="true"><path d="M7 13 V4 M3.4 7 L7 3.3 L10.6 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (dir < 0)
      return '<svg class="hm-arw hm-arw--down" viewBox="0 0 14 16" fill="none" aria-hidden="true"><path d="M7 13 V4 M3.4 7 L7 3.3 L10.6 7" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return '<svg class="hm-arw hm-arw--flat" viewBox="0 0 14 16" aria-hidden="true"><rect x="3" y="7.15" width="8" height="1.7" rx=".85" fill="currentColor"/></svg>';
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
    const arrow = arwSvg(v > 0 ? 1 : v < 0 ? -1 : 0);
    const cls = tierCellCls(w);
    const inner = cls
      ? `${arrow}${fmtPct(v)}`
      : `<span class="${v > 0 ? "num-inline-pos" : "num-inline-neg"}">${arrow}${fmtPct(v)}</span>`;
    return [inner, cls];
  };
  const findWin = (windows, mins) => windows.find((w) => w.mins === mins);
  const winByLabel = (windows, label) => windows.find((w) => w.label === label);

  // Собираем плоский упорядоченный список строк для реконсилера. Каждая запись —
  // {key, cls, html}: одна <tr>. У открытой монеты следом идёт под-строка статуса
  // (ключ "pos:COIN"), чтобы она переживала тики вместе с ней, а не моргала.
  const items = [];

  enriched.forEach((x, idx) => {
    const s = x.s;
    const w2 = findWin(x.windows, 2) || winByLabel(x.windows, "2m");
    const w5 = findWin(x.windows, 5) || winByLabel(x.windows, "5m");
    const w15 = findWin(x.windows, 15) || winByLabel(x.windows, "15m");
    const trendPct = s.trendPct;
    // Lookback (напр. 60m) уехал в тултип — суффикс «/ 60m» резался колонкой в «…».
    const trendInner =
      trendPct == null
        ? '<span class="num-inline-muted">—</span>'
        : `<span class="${trendPct > 0 ? "num-inline-pos" : "num-inline-neg"}" title="price trend over ${th.trendLookbackMin || "?"}m">${arwSvg(trendPct > 0 ? 1 : -1)}${fmtPct(trendPct)}</span>`;

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
    const rowCls = ["hm-main", isOpen ? "is-active" : "", heatCls]
      .filter(Boolean)
      .join(" ");

    // (Чип «движ за/против позиции» убран 2026-06-28: дубль с направлением хода в
    // %-ячейках; «with/against» подан криптично. Exit ведёт бот/adopt + под-строка.)

    // Биржевая flash-вспышка: цена выросла с прошлого рендера → зелёный,
    // упала → красный. Цена-ячейка пересоздаётся при смене html → анимация
    // играет заново на новом DOM-узле.
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
        // exit-сигнал «движ ещё жив или выдыхается».
        const [inner, cls] = pctCellTiered(w);
        const klass = ["hm-window", "r", cls].filter(Boolean).join(" ");
        return `<td class="${klass}" data-w="${lbl}">${inner}</td>`;
      })
      .join("");

    // Accel: |w2| vs линейная экстраполяция w5 (×0.4). Ratio ≥1.2 = ускорение
    // (не фейди), ≤0.6 = выдыхается (хороший момент), знаки разные = разворот.
    let accelInner = '<span class="num-inline-muted">—</span>';
    let accelCellCls = "";
    let accelKind = null; // 'up' | 'down' | 'flat' | 'rev' | null
    if (w2 && w5 && w2.spikePct != null && w5.spikePct != null) {
      const a = w2.spikePct,
        b = w5.spikePct;
      if (Math.abs(b) < 0.05) {
        accelInner = `<span class="num-inline-muted">${arwSvg(0)}</span>`;
        accelKind = "flat";
      } else if (a > 0 !== b > 0 && Math.abs(a) > 0.2) {
        accelInner = `<span style="color:var(--accent)">${icon("recompute")} rev</span>`;
        accelKind = "rev";
      } else {
        const expected = b * 0.4;
        const ratio = expected !== 0 ? Math.abs(a) / Math.abs(expected) : 0;
        if (ratio >= 1.2) {
          accelInner = `<span style="color:var(--red)">${arwSvg(1)}${ratio.toFixed(1)}×</span>`;
          accelCellCls = "num-neg-weak";
          accelKind = "up";
        } else if (ratio <= 0.6) {
          accelInner = `<span style="color:var(--green)">${arwSvg(-1)}${ratio.toFixed(1)}×</span>`;
          accelCellCls = "num-pos-weak";
          accelKind = "down";
        } else {
          accelInner = `<span class="num-inline-muted">${arwSvg(0)}${ratio.toFixed(1)}×</span>`;
          accelKind = "flat";
        }
      }
    }

    // Vol×: серверный multiplier (5min recent / avg 5min over hour).
    let volInner = '<span class="num-inline-muted">…</span>';
    let volKind = null; // 'high' | 'mid' | 'normal' | 'thin' | null
    if (typeof s.volMult === "number" && isFinite(s.volMult)) {
      const v = s.volMult;
      let color = "var(--text-muted)";
      if (v >= 2) {
        color = "var(--red)";
        volKind = "high";
      } else if (v >= 1.3) {
        color = "var(--orange, #f59e0b)";
        volKind = "mid";
      } else if (v <= 0.5) {
        color = "var(--green)";
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
    const setup = computeMomentum(x.windows, accelKind, volKind, x.s, flush);

    // Честный вердикт: continuation-вердикт карточки бэктестился в МИНУС
    // (−0.16%/30м, win 42%, 1752 сигнала), поэтому «вход» здесь не загорается
    // никогда — только приглушённый контекст направления, Enter='—'.
    let setupCls = setup.cls;
    let setupLabel = setup.label;
    let setupTitle = setup.title;
    const entryState = "none";
    const entryTitle = isOpen
      ? ""
      : "context only — continuation backtests negative, this is not an entry";
    if (!isOpen) {
      // Гасим до wait-вида: сторона и тинт строки всё ещё показывают движение,
      // но Enter остаётся '—'.
      setupCls =
        setup.side === "LONG" ? "setup-wait-long"
        : setup.side === "SHORT" ? "setup-wait-short"
        : "setup-none";
      setupLabel = setupLabel.replace(/<i class="setup-dot"[^>]*><\/i>/, ""); // снять STRONG-точку «вход»
      setupTitle = `Context direction (momentum), NOT a trade. · ${setup.title}`;
    }

    // OI delta 5m — нейтральная раскраска: OI сам по себе не хорош/плох.
    let oiInner = '<span class="num-inline-muted">—</span>';
    if (typeof s.oiDelta5m === "number" && isFinite(s.oiDelta5m)) {
      const v = s.oiDelta5m;
      const arrow = arwSvg(v > 0 ? 1 : -1);
      if (Math.abs(v) >= 3) {
        oiInner = `<span style="color:var(--accent);font-weight:600">${arrow}${fmtPct(v)}</span>`;
      } else if (Math.abs(v) >= 1) {
        oiInner = `<span style="color:var(--text-muted)">${arrow}${fmtPct(v)}</span>`;
      } else {
        oiInner = `<span class="num-inline-muted">${fmtPct(v)}</span>`;
      }
    }

    // У открытой монеты Setup-вердикт неактуален (вход сделан) → показываем live
    // OI-дельту 15м: растёт OI = в позицию заходит новый объём (топливо движа),
    // падает OI = участники разгружаются (движ выдыхается / шорты крывают). Окно
    // 15м (а не 5м) — чтобы не дублировать соседнюю колонку OI 5M. Нейтральная
    // раскраска: OI сам по себе не хорош/плох. Заменил тяжёлый Vol× — он считается
    // только в /api/signals и в живом WS-броадкасте всегда был «—» (2026-06-28).
    let openSetupHtml = '<span class="num-inline-muted">—</span>';
    if (typeof s.oiDelta15m === "number" && isFinite(s.oiDelta15m)) {
      const v = s.oiDelta15m;
      const arrow = arwSvg(v > 0 ? 1 : -1);
      const color = Math.abs(v) >= 3 ? "var(--accent)" : "var(--text-muted)";
      openSetupHtml = `<span style="color:${color};font-weight:600">OI 15m ${arrow}${fmtPct(v)}</span>`;
    }
    const setupCell = isOpen
      ? `<td class="hm-setup c" data-w="Setup" title="Open-interest change over 15m: rising = new money entering the move (fuel), falling = participants closing">${openSetupHtml}</td>`
      : `<td class="hm-setup c ${setupCls}" data-w="Setup" title="${setupTitle}"><span class="hm-setup-pill">${setupLabel}</span></td>`;

    // ENTER: для открытой монеты вход неактуален — вместо таймера ОДНА стрелка,
    // которая поворачивается ПО МНЕ, а не по цене: up (зелёная) = движ в мою
    // сторону, down (красная) = против, mid при почти нулевом движении. Сама
    // стрелка — персистентный узел (см. mountDirArrows ниже): строка
    // перестраивается каждый тик, а узел переживает, поэтому поворот реально
    // твинит. Управление/выход — в под-строке (2026-06-16: цена→прибыль).
    let entryCell;
    if (isOpen) {
      // Направление = согласие движа со стороной позиции (та же логика, что у
      // hm-align ✓/✗): SHORT в плюс при падении, LONG в плюс при росте. Без
      // известного side или почти без движа — mid (нейтрально, серый).
      const aSide = (getActivePos(s.coin)?.side || "").toUpperCase();
      const aligned = aSide === "SHORT" ? domMove < 0 : domMove > 0;
      const dir = moveAbs < 0.05 || !aSide ? "mid" : aligned ? "up" : "down";
      const tip =
        dir === "up" ? "price moving your way" : dir === "down" ? "price moving against you" : "barely moving";
      entryCell = `<td class="hm-entry hm-dir" data-w="Dir" title="in position — ${tip}"><span class="hm-entry-icon"><span class="hm-dir-mount" data-dir="${dir}"></span></span></td>`;
    } else {
      const eico = ENTRY_ICON_SVG[entryState] || ENTRY_ICON_SVG.none;
      entryCell = `<td class="hm-entry hm-entry-${entryState}" data-w="Enter" title="${entryTitle}"><span class="hm-entry-icon">${eico}</span></td>`;
    }

    // Пассивный тег старшего тренда (1h EMA): не входить против него — главный
    // леак (контр-тренд). s.htfTrend = 'up'|'down'|'flat'|'none' из enrichHtfTrend.
    let htfChip = "";
    if (s.htfTrend === "up")
      htfChip = `<span class="hm-htf num-inline-pos" style="margin-left:6px;font-size: var(--fs-label);font-weight:600" title="Higher timeframe 1h trend UP — longs go with it; shorts fight it">1h ${icon("long")}</span>`;
    else if (s.htfTrend === "down")
      htfChip = `<span class="hm-htf num-inline-neg" style="margin-left:6px;font-size: var(--fs-label);font-weight:600" title="Higher timeframe 1h trend DOWN — shorts go with it; longs fight it">1h ${icon("short")}</span>`;
    else if (s.htfTrend === "flat")
      htfChip = `<span class="hm-htf num-inline-muted" style="margin-left:6px;font-size: var(--fs-label)" title="Higher timeframe 1h trend flat — no tailwind either way">1h ${icon("flat")}</span>`;

    // Чип Vol/OI: суточный оборот ≥ открытого интереса (Vol ≥ OI). На HL это
    // редкость (норма OI>Vol, медиана ~3×), поэтому Vol≥OI = монета сегодня реально
    // крутится: высокий turnover, деньги входят-выходят, а не залегли. 2026-06-29.
    let oiVolChip = "";
    const volOi =
      s.oiUsd > 0 && s.vol24hUsd > 0 ? s.vol24hUsd / s.oiUsd : null;
    if (typeof volOi === "number" && isFinite(volOi) && volOi >= VOL_OI_PARTY) {
      const tip =
        `Daily turnover is ${volOi.toFixed(1)}× open interest: 24h vol ${fmtUsdShort(s.vol24hUsd)} ≥ OI ${fmtUsdShort(s.oiUsd)}. ` +
        `On HL it is usually the other way round (OI>Vol), so this is rare: the coin is churning today — ` +
        `money moving in and out rather than sitting.`;
      oiVolChip = `<span class="hm-oivol" style="margin-left:6px;font-size: var(--fs-label);font-weight:600" title="${escapeHtml(tip)}">Vol ${volOi.toFixed(1)}× OI</span>`;
    }

    const rowHtml = `
      <td>${isOpen ? icon("pinned", { label: "Open position" }) : idx + 1}</td>
      <td><a class="signals-price hm-coin-link" href="${tvUrl(s.coin)}" target="_blank" rel="noopener" title="Open ${escapeHtml(s.coin)} in TradingView">#${escapeHtml(s.coin)}</a>${htfChip}${oiVolChip}</td>
      ${setupCell}
      ${entryCell}
      <td class="hm-price-cell r ${flashCls}"><span class="hm-price-inner"><span class="hm-spark-wrap" title="Price over ~20 min (live)">${sparkSvg(s.spark)}</span><span class="signals-price">${fmtPrice(s.price)}</span></span></td>
      ${cells}
      <td class="r ${accelCellCls}" data-w="Acc">${accelInner}</td>
      <td class="r" data-w="OI">${oiInner}</td>
      <td class="r" data-w="Trend">${trendInner}</td>`;

    items.push({ key: `m:${s.coin}`, cls: rowCls, html: rowHtml });

    // Под-строка статуса открытой позиции (стоп/BE/трейл/пик/ликв). Если бот
    // ничего не делает — hmPosHintInner вернёт "" и под-строки не будет.
    if (isOpen) {
      const posInner = hmPosHintInner(s.coin);
      if (posInner)
        items.push({ key: `pos:${s.coin}`, cls: "hm-pos-row", html: posInner });
    }

  });

  // Добиваем таблицу пустыми строками до HM_MAX_ROWS, чтобы высота не прыгала
  // при малом числе монет (4 монеты → 4 пустышки). Плейсхолдеры — keyed (ph:N),
  // едут через тот же реконсилер, но БЕЗ появления/ухода и проезда (см.
  // reconcileRows): монета въезжает в «освободившийся» пустой слот, пустышки не
  // мельтешат. Считаем по ОСНОВНЫМ строкам (enriched.length), под-строки позиции
  // (pos:) — отдельная намеренная высота, их не компенсируем.
  if (enriched.length === 0) {
    // Пустой enriched = монеты ещё не посчитаны (universe прогревается). Это НЕ
    // «тихий рынок»: карточка заполняется топом по momentum БЕЗ отсечки по ходу,
    // поэтому при загруженном universe строк всегда ≥1. Старый текст «quiet
    // market — no movers» врал во время загрузки → показываем прелоадер с
    // индетерминантным прогресс-баром, пока монеты не приедут (= «когда готово»).
    // Если universe уже известен — поясняем, сколько монет сканируется.
    const scope = payload?.universeSize
      ? ` · scanning ${payload.universeSize} coins`
      : "";
    // Стартовую ширину ставим инлайном = текущий % (RAF продолжит между тиками,
    // но при пересоздании строки реконсилером ширина не мигает на 0).
    const startW = hmProgressPct().toFixed(1);
    const statusHtml =
      '<span class="loader-spinner hm-status-spinner"></span>' +
      `<span>Loading movers…${scope}</span>` +
      `<span class="hm-status-bar" aria-hidden="true"><span class="hm-status-bar-fill" style="width:${startW}%"></span></span>`;
    items.push({
      key: "ph:status",
      cls: "hm-status-row",
      html: `<td colspan="11" class="hm-status-cell">${statusHtml}</td>`,
    });
    startHmProgress();
  } else {
    finishHmProgress();
    // Есть хотя бы одна монета → добиваем пустыми строками до HM_MAX_ROWS,
    // чтобы высота карточки не прыгала при малом числе монет.
    const placeholdersNeeded = Math.max(0, HM_MAX_ROWS - enriched.length);
    for (let i = 0; i < placeholdersNeeded; i++) {
      items.push({
        key: `ph:${i}`,
        cls: "hm-placeholder-row",
        html: '<td colspan="11" class="hm-ph-cell"><span class="signals-price">&nbsp;</span></td>',
      });
    }
  }

  reconcileRows(tbody, items);
  mountDirArrows(tbody);
  stabilizeHeight(tbody);
}

let _hmFixedH = 0; // последняя выставленная высота обёртки (анти-трэшинг layout)

// Гасим прыжок высоты карточки: основные строки добиты плейсхолдерами до
// HM_MAX_ROWS, высота обёртки = thead + HM_MAX_ROWS строк. Меряем, а не
// хардкодим: иконки Enter и кегль делают строку выше.
//
// 🚨 Под-строки открытых позиций (`pos:`) входят в расчёт: без них карточка
// получала прокрутку ровно когда позиция открыта, и строка позиции уезжала
// под её нижний край.
function stabilizeHeight(tbody) {
  const wrap = tbody.closest(".hm-scroll-wrap");
  if (!wrap) return;
  const table = tbody.parentElement; // <table>, внутри thead+tbody
  const thead = table?.querySelector("thead");
  // Эталон высоты строки: первая основная (m:) или пустышка (ph:) — у них
  // постоянная высота. Под-строки (pos/fh) ниже и для эталона не годятся.
  const sample =
    tbody.querySelector('tr[data-hmkey^="m:"]') ||
    tbody.querySelector("tr.hm-placeholder-row");
  const rowH = sample?.offsetHeight || 0;
  const headH = thead?.offsetHeight || 0;
  if (rowH <= 0) return; // пустое состояние (статус-строка) — высоту не трогаем
  // Под-строки меряем поимённо: они ниже основных и у каждой своя высота
  // (позиция с бейджем переносится на узком экране).
  let subH = 0;
  for (const tr of tbody.querySelectorAll(".hm-pos-row, .hm-fadehot-row")) {
    subH += tr.offsetHeight;
  }
  const target = headH + rowH * HM_MAX_ROWS + subH;
  if (Math.abs(target - _hmFixedH) > 1) {
    wrap.style.height = `${target}px`;
    _hmFixedH = target;
  }
}

// Персистентные стрелки активной монеты: строки перестраиваются (innerHTML)
// каждый тик, поэтому переносим ОДИН и тот же DOM-узел стрелки в перестроенную
// ячейку (appendChild сохраняет identity). Глифом/цветом/спином узла управляет
// updateHotMoversLiveArrow() по ЖИВОЙ цене (WS ≤2с) — здесь только держим узел
// смонтированным, чтобы его не сбрасывало перестроение строки.
const _hmDirArrows = new Map(); // coin → <span.hm-dir-arrow>
const _hmLivePrevPx = new Map(); // coin → последняя цена (для детекта изменения)

function mountDirArrows(tbody) {
  const seen = new Set();
  for (const mount of tbody.querySelectorAll(".hm-dir-mount")) {
    const row = mount.closest("tr");
    const key = row?.dataset.hmkey || ""; // "m:COIN"
    const coin = key.startsWith("m:") ? key.slice(2) : key;
    if (!coin) continue;
    seen.add(coin);
    let arrow = _hmDirArrows.get(coin);
    if (!arrow) {
      arrow = document.createElement("span");
      arrow.className = "hm-dir-arrow";
      // Стартовый шеврон из направления скан-тика — серый, до первого живого тика.
      initChevronArrow(arrow);
      arrow.classList.add(mount.dataset.dir === "down" ? "down" : "up");
      bindArrowPopEnd(arrow); // снимать флаг волны по завершении
      _hmDirArrows.set(coin, arrow);
    }
    if (arrow.parentNode !== mount) mount.appendChild(arrow);
  }
  // Монета закрылась/ушла из таблицы — отпускаем узел (не копим Map).
  for (const coin of _hmDirArrows.keys())
    if (!seen.has(coin)) {
      _hmDirArrows.delete(coin);
      _hmLivePrevPx.delete(coin);
    }
}

// Живой спин стрелки активной монеты — дёргается из onStatus по WS-status (≤2с),
// независимо от скан-тика Hot Movers. Для каждой активной монеты берёт текущую
// цену (getActivePos().now) и, если она изменилась, играет волну В МОЮ СТОРОНУ:
// favor (движ в плюс позиции) → зелёный шеврон/ракета вверх, against → красный
// вниз. Для SHORT выгода = падение цены, для LONG = рост (2026-06-16).
export function updateHotMoversLiveArrow() {
  for (const [coin, arrow] of _hmDirArrows) {
    const pos = getActivePos(coin);
    const px = pos?.now;
    if (px == null || !Number.isFinite(px)) continue;
    const prev = _hmLivePrevPx.get(coin);
    if (prev != null && px !== prev && prev > 0) {
      const deltaPct = (Math.abs(px - prev) / prev) * 100;
      const priceUp = px > prev;
      const side = (pos?.side || "").toUpperCase();
      // favor = движ в мою сторону. Без известного side падаем на сырое priceUp.
      const favor = side === "SHORT" ? !priceUp : priceUp;
      popArrow(arrow, favor, deltaPct);
    }
    _hmLivePrevPx.set(coin, px);
  }
}

// ── keyed-реконсилер с проездом строк ──
// items: [{key, cls, html}] в желаемом порядке. Узлы <tr> переживают тики
// (по data-hmkey): меняется только то, что изменилось, а смена порядка
// проигрывается как сдвиг (FLIP, см. ниже).
function reconcileRows(tbody, items) {
  const reduceMotion =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Живые (не уходящие) строки по ключу. Узлы без data-hmkey — это плейсхолдеры
  // (стартовый «Waiting for price history…» из HTML или empty-state) — выкидываем
  // сразу, иначе реконсилер их не трогает и они висят под монетами.
  const live = new Map();
  for (const el of Array.from(tbody.children)) {
    const k = el.dataset.hmkey;
    if (!k) {
      el.remove();
      continue;
    }
    if (!el.classList.contains("hm-leaving")) live.set(k, el);
  }
  const desired = new Set(items.map((i) => i.key));

  // FIRST: где строки стояли ДО перестановки — для инверсии (FLIP).
  const firstTop = new Map();
  if (!reduceMotion)
    for (const [k, el] of live) firstTop.set(k, el.getBoundingClientRect().top);

  // Плейсхолдеры (ph:N) — пустые добивочные строки: едут через реконсилер, но
  // без появления/ухода, чтобы не мельтешить (монета просто занимает
  // освободившийся пустой слот).
  const isPh = (k) => k.startsWith("ph:");

  // EXIT: строки, которых больше нет в желаемом наборе — гасим и удаляем.
  for (const [k, el] of live) {
    if (desired.has(k)) continue;
    if (reduceMotion || isPh(k)) {
      el.remove();
      continue;
    }
    el.classList.add("hm-leaving");
    el.dataset.hmkey = ""; // снять с учёта, чтобы не матчился новой строкой
    const done = () => el.remove();
    el.addEventListener("animationend", done, { once: true });
    setTimeout(done, 600); // подстраховка, если animationend не придёт
  }

  // BUILD/UPDATE + расстановка в нужном порядке.
  const ordered = [];
  let anchor = null;
  for (const item of items) {
    let el = live.get(item.key);
    let entering = false;
    if (!el) {
      el = document.createElement("tr");
      el.dataset.hmkey = item.key;
      entering = true;
    }
    if (el.__hmHtml !== item.html) {
      el.innerHTML = item.html;
      el.__hmHtml = item.html;
    }
    const cls = entering ? item.cls : `${item.cls}`;
    if (el.className !== cls) el.className = cls;
    // Вставляем на нужное место (не трогаем DOM, если уже там — без лишних reflow).
    if (anchor == null) {
      if (tbody.firstElementChild !== el) tbody.insertBefore(el, tbody.firstChild);
    } else if (anchor.nextElementSibling !== el) {
      anchor.after(el);
    }
    anchor = el;
    ordered.push({ el, key: item.key, entering });
  }

  // 🚨 В фоновой вкладке кадров нет: анимация повиснет на нулевом, и строка
  // останется смещённой на весь dy до возврата на вкладку.
  if (reduceMotion || document.visibilityState !== "visible") return;

  // ── LAST + INVERT + PLAY ──
  //
  // 🚨 Через Web Animations API, а не style.transition: тик каждые 2с
  // перебивает незакончившийся переход, браузер берёт за старт уже сдвинутое
  // состояние и строку дёргает. `el.animate()` отменяется явно и живёт на
  // композиторе.
  for (const { el, key, entering } of ordered) {
    if (isPh(key)) continue; // плейсхолдеры не двигаем — мельтешение без смысла
    if (entering) {
      el.classList.add("hm-enter");
      el.addEventListener("animationend", () => el.classList.remove("hm-enter"), {
        once: true,
      });
      continue;
    }
    const prev = firstTop.get(key);
    if (prev == null) continue;
    const dy = prev - el.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;

    // Предыдущий проезд этой же строки — отменить, иначе два перекрывающихся
    // движения складываются и получается дрожь.
    el.__hmMove?.cancel();
    el.__hmMove = el.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
      {
        // 460 мс, плоский выход. Пружину не ставить: перелёт = дрожь.
        duration: 460,
        easing: "cubic-bezier(0.22, 0.61, 0.36, 1)",
        composite: "replace",
      },
    );
  }
}
