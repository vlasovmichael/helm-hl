// ─────────────────────────────────────────────────
//  Hot Movers — DOM-рендер таблицы (momentum + OI-режим + Setup-вердикт).
//  Чистая логика (computeMomentum/derive*) живёт в ./momentum.js.
//  fmtTime передаётся параметром — он зависит от currentRangeHours в main.js.
//
//  Рендер идёт через keyed-реконсилер (reconcileRows): строки переживают тики,
//  поэтому при смене ранга монета ГЛАЙДИТ на новое место (FLIP), новая —
//  въезжает, ушедшая — гаснет. Раньше innerHTML пересобирался целиком и строки
//  прыгали без анимации (2026-06-13).
// ─────────────────────────────────────────────────

import { escapeHtml } from "../utils/format.js";
import { popArrow, bindArrowPopEnd, initChevronArrow } from "../utils/arrowPop.js";
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

// TradingView-ссылка по монете (клик по тикеру в Hot Movers).
// HL k-монеты (kPEPE, kBONK…) на Binance = 1000-префикс (1000PEPE). .P =
// бессрочный перп — тот же инструмент, что торгует бот, и покрытие шире спота.
function tvUrl(coin) {
  let raw = String(coin || "").trim();
  if (/^k[A-Z0-9]/.test(raw)) raw = `1000${raw.slice(1)}`;
  const sym = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return `https://www.tradingview.com/chart/?symbol=BINANCE:${sym}USDT.P`;
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
      meta.innerHTML = `<span class="hm-flush-chip" title="Synchronized deleveraging across movers (${sharePct}% of top with OI↓) — fade against the move = catching a knife, muted">⚠️ ${word} ${sharePct}%</span> · ${escapeHtml(base)}`;
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

  // Собираем плоский упорядоченный список строк для реконсилера. Каждая запись —
  // {key, cls, html}: одна <tr>. У открытой монеты следом идёт под-строка статуса
  // (ключ "pos:COIN"), чтобы она тоже участвовала в FLIP, а не моргала.
  const items = [];

  enriched.forEach((x, idx) => {
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
    const rowCls = ["hm-main", isOpen ? "is-active" : "", heatCls]
      .filter(Boolean)
      .join(" ");

    // Активная монета: вместо бесполезного «поз.» — согласие движа со стороной
    // позиции. Это единственный exit-сигнал, которого нет в Active Position:
    // «движ ещё за меня (✓)» vs «развернулся против (✗)». P&L/стоп — там и в
    // под-строке (2026-06-13).
    let alignChip = "";
    if (isOpen) {
      const pos = getActivePos(s.coin);
      const side = (pos?.side || "").toUpperCase();
      const letter = side === "LONG" ? "L" : side === "SHORT" ? "S" : "?";
      let mark, kind, tip;
      if (!side || moveAbs < 0.05) {
        mark = "·";
        kind = "flat";
        tip = "движения почти нет — нейтрально";
      } else {
        const aligned = side === "SHORT" ? domMove < 0 : domMove > 0;
        mark = aligned ? "✓" : "✗";
        kind = aligned ? "ok" : "bad";
        tip = aligned
          ? `${side}: движ идёт в твою сторону — позиция в работе`
          : `${side}: движ развернулся ПРОТИВ — следи за выходом`;
      }
      alignChip = `<span class="hm-align hm-align-${kind}" title="${tip}">${letter}&nbsp;${mark}</span>`;
    }

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
        accelInner = '<span class="num-inline-muted">→</span>';
        accelKind = "flat";
      } else if (a > 0 !== b > 0 && Math.abs(a) > 0.2) {
        accelInner = '<span style="color:var(--accent)">↻ rev</span>';
        accelKind = "rev";
      } else {
        const expected = b * 0.4;
        const ratio = expected !== 0 ? Math.abs(a) / Math.abs(expected) : 0;
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

    // ── Честный вердикт (2026-06-19) ─────────────────────────────────────────
    // Actionable «🎯 вход» загорается ТОЛЬКО на подтверждённом эдже fade-high-ER
    // (s.fadeHot — единственное правило, пережившее OOS, см. memory
    // darkknight_backtest). Постоянный continuation-вердикт карточки бэктестился
    // в МИНУС (−0.16%/30м, win 42%, 1752 сигн) → его НЕ выдаём как сделку:
    // показываем приглушённым контекст-направлением (momentum), Enter='—'.
    // Карточка перестаёт «продавать» проигрышный continuation как вход.
    // Презентация-only: computeMomentum/серверный двойник/ntfy не трогаем.
    let setupCls = setup.cls;
    let setupLabel = setup.label;
    let setupTitle = setup.title;
    let entryState = "none"; // для незанятой монеты переопределяется ниже (zone при fade-high-ER)
    let entryTitle = "";
    const fh = s.fadeHot;
    if (!isOpen) {
      if (fh?.fired) {
        // Эдж: яркий fade-пилл (сторона ПЕРЕБИВАЕТ continuation) + 🎯 вход.
        // План (зона/стоп/выход) — в под-строке fh:COIN ниже.
        const up = fh.side === "LONG";
        const moveTxt = fh.move != null ? fmtPct(fh.move) : "—";
        const erTxt = fh.er != null ? fh.er.toFixed(2) : "—";
        setupCls = up ? "setup-fade-long" : "setup-fade-short";
        setupLabel = `<span class="setup-pill">🔥 ${fh.side} FADE</span>`;
        setupTitle =
          `🎯 ЭДЖ: fade выдохшегося хвоста — ход 30м ${moveTxt} при Kaufman ER 4ч ${erTxt}. ` +
          `Единственное правило, пережившее OOS. План входа — в строке ниже.`;
        entryState = "zone";
        entryTitle = `${fh.side} FADE — вход у текущей цены (выдохшийся хвост). План в строке ниже.`;
      } else {
        // Нет эджа: continuation = контекст, не сделка. Гасим до wait-вида,
        // Enter='—'. Сторона/тинт строки и %-ячейки всё ещё показывают движение.
        setupCls =
          setup.side === "LONG" ? "setup-wait-long"
          : setup.side === "SHORT" ? "setup-wait-short"
          : "setup-none";
        setupLabel = setupLabel.replace(" ●", ""); // снять STRONG-точку «вход»
        setupTitle =
          `Контекст-направление (momentum), НЕ сделка — continuation в минус по бэктесту. ` +
          `Жди 🔥 fade-high-ER. · ${setup.title}`;
        entryState = "none";
        entryTitle = "эджа нет — continuation бэктестится в минус, ждём fade-high-ER (🔥)";
      }
    }

    // OI delta 5m — нейтральная раскраска: OI сам по себе не хорош/плох.
    let oiInner = '<span class="num-inline-muted">—</span>';
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
        dir === "up" ? "цена в твою сторону" : dir === "down" ? "цена против тебя" : "движения почти нет";
      entryCell = `<td class="hm-entry hm-dir" data-w="Dir" title="в позиции — ${tip}"><span class="hm-entry-icon"><span class="hm-dir-mount" data-dir="${dir}"></span></span></td>`;
    } else {
      const eico = ENTRY_ICON_SVG[entryState] || ENTRY_ICON_SVG.none;
      entryCell = `<td class="hm-entry hm-entry-${entryState}" data-w="Enter" title="${entryTitle}"><span class="hm-entry-icon">${eico}</span></td>`;
    }

    // Пассивный тег старшего тренда (1h EMA): не входить против него — главный
    // леак (контр-тренд). s.htfTrend = 'up'|'down'|'flat'|'none' из enrichHtfTrend.
    let htfChip = "";
    if (s.htfTrend === "up")
      htfChip = `<span class="hm-htf num-inline-pos" style="margin-left:6px;font-size:11px;font-weight:600" title="Старший тренд 1h ВВЕРХ — лонг по тренду; шорт против него = ловишь нож">1h ↑</span>`;
    else if (s.htfTrend === "down")
      htfChip = `<span class="hm-htf num-inline-neg" style="margin-left:6px;font-size:11px;font-weight:600" title="Старший тренд 1h ВНИЗ — шорт по тренду; лонг против него = ловишь нож">1h ↓</span>`;
    else if (s.htfTrend === "flat")
      htfChip = `<span class="hm-htf num-inline-muted" style="margin-left:6px;font-size:11px" title="Старший тренд 1h — флэт/боковик: чёткого попутного ветра нет">1h →</span>`;

    const rowHtml = `
      <td>${isOpen ? "📍" : idx + 1}</td>
      <td><a class="signals-price hm-coin-link" href="${tvUrl(s.coin)}" target="_blank" rel="noopener" title="Открыть ${escapeHtml(s.coin)} в TradingView">#${escapeHtml(s.coin)}</a>${alignChip}${htfChip}</td>
      ${setupCell}
      ${entryCell}
      <td class="hm-price-cell r ${flashCls}"><span class="signals-price">${fmtPrice(s.price)}</span></td>
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

    // Под-строка forward-сигнала «fade выдохшегося хвоста» (high-ER). Сервер
    // (enrichFadeHot) ставит s.fadeHot когда |ход 30м|≥3% И Kaufman ER 4ч≥0.47.
    // Это РЕДКИЙ событийный пилл (≈0.3% баров): монета+сторона+зона+стоп+выход.
    // Рядом тихо меряет paper-слот strategy_id='fadehot'. Показываем всегда (и в
    // открытой монете — это контр-сигнал к её позиции). `fh` объявлен выше
    // (честный-вердикт блок) — переиспользуем, не редекларируем.
    if (fh?.fired) {
      const sideCls = fh.side === "SHORT" ? "fh-short" : "fh-long";
      const zone =
        fh.zoneLo != null && fh.zoneHi != null
          ? `$${fmtPrice(fh.zoneLo)}–$${fmtPrice(fh.zoneHi)}`
          : fmtPrice(s.price);
      const erTxt = fh.er != null ? fh.er.toFixed(2) : "—";
      const moveTxt = fh.move != null ? fmtPct(fh.move) : "—";
      const stopTxt = fh.stop != null ? `$${fmtPrice(fh.stop)}` : "—";
      const stopPct = fh.stopPct != null ? `${fh.stopPct}%` : "";
      const exitTxt = fh.timeStopMin != null ? `~${Math.round(fh.timeStopMin / 60)}ч` : "~2ч";
      const tip =
        `Fade an exhausted tail: 30m move ${moveTxt} at Kaufman ER 4h ${erTxt} (≥0.47). ` +
        `Fade AGAINST the move. Time-stop exit ${exitTxt} + wide stop ${stopPct}. ` +
        `Marginal forward candidate — a paper slot measures it alongside.`;
      const inner = `<td colspan="11">
        <span class="hm-fh-tag ${sideCls}" title="${tip}">🔥 tail fade ${fh.side}</span>
        <span class="hm-fh-meta">zone ${zone} · stop ${stopTxt} (${stopPct}) · exit ${exitTxt} · ER ${erTxt}</span>
      </td>`;
      items.push({ key: `fh:${s.coin}`, cls: "hm-fadehot-row", html: inner });
    }
  });

  // Добиваем таблицу пустыми строками до HM_MAX_ROWS, чтобы высота не прыгала
  // при малом числе монет (4 монеты → 4 пустышки). Плейсхолдеры — keyed (ph:N),
  // едут через тот же реконсилер, но БЕЗ enter/leave/FLIP-анимаций (см.
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

// Гасим прыжок высоты карточки при смене монет. Основные строки уже добиты
// плейсхолдерами до HM_MAX_ROWS, но под-строки (`pos:` позиция, `fh:` fade-хвоста)
// — внеплановая высота, и в горячем рынке (8 реальных монет → 0 плейсхолдеров)
// гасить их нечем. Поэтому фиксируем высоту ОБЁРТКИ = thead + HM_MAX_ROWS строк:
// лишние под-строки скроллятся внутри, внешний размер карточки = const всегда.
// Высоту меряем (иконки Enter 26px / шрифт делают строку выше хардкода), кэшируем.
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
  const target = headH + rowH * HM_MAX_ROWS;
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

// ── keyed-реконсилер с FLIP-анимациями ──
// items: [{key, cls, html}] в желаемом порядке. Узлы <tr> переживают тики
// (по data-hmkey), поэтому смену порядка можно проиграть как плавный сдвиг.
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

  // FIRST: позиции выживших строк ДО перестановки (для инверсии FLIP).
  const firstTop = new Map();
  if (!reduceMotion)
    for (const [k, el] of live)
      firstTop.set(k, el.getBoundingClientRect().top);

  // Плейсхолдеры (ph:N) — пустые добивочные строки: едут через реконсилер, но
  // БЕЗ enter/leave/FLIP, чтобы не мельтешить и не трогать красивую анимацию
  // реальных монет (монета просто въезжает в освободившийся пустой слот).
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

  if (reduceMotion) return;

  // LAST + INVERT + PLAY.
  for (const { el, key, entering } of ordered) {
    if (isPh(key)) continue; // плейсхолдеры без анимации (мгновенно)
    if (entering) {
      el.classList.add("hm-enter");
      el.addEventListener(
        "animationend",
        () => el.classList.remove("hm-enter"),
        { once: true },
      );
      continue;
    }
    const prev = firstTop.get(key);
    if (prev == null) continue;
    const now = el.getBoundingClientRect().top;
    const dy = prev - now;
    if (Math.abs(dy) < 1) continue;
    el.style.transition = "none";
    el.style.transform = `translateY(${dy}px)`;
    requestAnimationFrame(() => {
      el.style.transition = "transform .42s cubic-bezier(.22,.61,.36,1)";
      el.style.transform = "";
    });
    el.addEventListener(
      "transitionend",
      () => {
        el.style.transition = "";
        el.style.transform = "";
      },
      { once: true },
    );
  }
}
