// ─────────────────────────────────────────────────
//  Hot Movers — DOM-рендер таблицы (momentum + OI-режим + Setup-вердикт).
//  Чистая логика (computeMomentum/hmEntryBadge/derive*) живёт в ./momentum.js.
//  fmtTime передаётся параметром — он зависит от currentRangeHours в main.js.
//
//  Рендер идёт через keyed-реконсилер (reconcileRows): строки переживают тики,
//  поэтому при смене ранга монета ГЛАЙДИТ на новое место (FLIP), новая —
//  въезжает, ушедшая — гаснет. Раньше innerHTML пересобирался целиком и строки
//  прыгали без анимации (2026-06-13).
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
  hmPosHintInner,
  getActiveCoins,
  getActivePos,
} from "../state/activeCoins.js";

const _hmPrevPrices = new Map();

// Клик по строке Hot Movers → открыть монету в TradingView (новая вкладка).
// Если задать ID сохранённого TV-лэйаута — откроется он (с твоими EMA20/200);
// пусто → дефолтный график. Символ по умолчанию Binance perp (как у оператора в TV).
const TV_LAYOUT_ID = ""; // напр. "abcd1234" из https://tradingview.com/chart/abcd1234/
function openTradingView(coin) {
  const sym = `BINANCE:${String(coin).toUpperCase().replace(/[^A-Z0-9]/g, "")}USDT`;
  const base = TV_LAYOUT_ID
    ? `https://www.tradingview.com/chart/${TV_LAYOUT_ID}/`
    : "https://www.tradingview.com/chart/";
  window.open(`${base}?symbol=${encodeURIComponent(sym)}`, "_blank", "noopener");
}

// Сколько монет максимум в таблице (открытые позиции — сверх лимита, всегда).
const HM_MAX_ROWS = 8;
// momScore ниже порога = WAIT (хода нет) — такие строки прячем, кроме открытых.
const HM_WAIT_SCORE = 1.5;

export function renderHotMovers(payload, fmtTime) {
  const tbody = document.getElementById("hot-movers-tbody");
  const meta = document.getElementById("hot-movers-meta");
  if (!tbody || !meta) return;

  // Делегированный клик по строке монеты → TradingView (вешаем один раз).
  if (!tbody.dataset.tvBound) {
    tbody.dataset.tvBound = "1";
    tbody.addEventListener("click", (e) => {
      const row = e.target.closest("tr[data-hmkey]");
      const m = /^(?:m|pos):(.+)$/.exec(row?.dataset.hmkey || "");
      if (m) openTradingView(m[1]);
    });
  }
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
  // Остальные строки: режем до лимита и ПРЯЧЕМ WAIT — но только пока есть что
  // показывать. WAIT-порог по momScore высокий (нужен ~1%+ ход), поэтому в
  // тихом рынке под него не проходит почти никто. Чтобы карточка не пустела
  // (оставались одни активные), при нехватке не-WAIT добиваем сильнейшими
  // движущимися монетами. dead-flat (|ход|<0.2% по всем окнам) прячем всегда.
  const slots = Math.max(0, HM_MAX_ROWS - activeRows.length);
  const movingRest = sorted.filter(
    (x) => !isActiveCoin(x.s.coin) && x.maxAbs >= 0.2,
  );
  const nonWait = movingRest.filter((x) => x.momScore >= HM_WAIT_SCORE);
  const restRows = (
    nonWait.length >= Math.min(4, slots) ? nonWait : movingRest
  ).slice(0, slots);
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
    const entry = hmEntryBadge(x.windows, setup.side, setup.score, setup.mode);

    // Chase-gate: actionable Setup-пилл (trend/fade score≥3), но цена уже ⛔
    // растянута в сторону сделки (entry.state==='extended') — вход проехал.
    // Гасим яркий пилл до wait-вида (как fade-mute при flush), чтобы «LONG
    // TREND» на хае не выглядел кнопкой «вход». Колонка Enter и так показывает
    // ⛔, но яркий пилл перетягивал глаз и провоцировал вход на топе.
    // Презентационно: actionable-решение ntfy (evaluateCoinAlert) уже требует
    // chase==='zone', так что пуши на extended и не приходят — синхронизируем
    // лишь визуал таблицы. (entry.state==='extended' ⇒ side+mode+score≥3.)
    let setupCls = setup.cls;
    let setupLabel = setup.label;
    let setupTitle = setup.title;
    if (!isOpen && entry.state === "extended") {
      setupCls = setup.side === "LONG" ? "setup-wait-long" : "setup-wait-short";
      setupLabel = setupLabel.replace(" ●", ""); // снять STRONG-точку «вход»
      setupTitle = `⛔ ПОЗДНО — ${entry.title}. Сетап есть, но вход проехал — жди отката (🎯). · ${setup.title}`;
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
      : `<td class="hm-setup c ${setupCls}" data-w="Setup" title="${setupTitle}">${setupLabel}</td>`;

    // ENTER: для открытой монеты вход неактуален — вместо таймера ОДНА стрелка,
    // которая поворачивается по направлению цены (up=0° / mid=90° / down=180°)
    // с плавным transition и сменой цвета. Сама стрелка — персистентный узел
    // (см. mountDirArrows ниже): строка перестраивается каждый тик, а узел
    // переживает, поэтому поворот реально твинит. Управление/выход — в под-строке.
    let entryCell;
    if (isOpen) {
      // Направление = знак domMove (то же, что тинт строки и hm-align): up/down,
      // mid при почти нулевом движении (порог как у align-чипа).
      const dir = moveAbs < 0.05 ? "mid" : domMove > 0 ? "up" : "down";
      const tip =
        dir === "up" ? "price moving up" : dir === "down" ? "price moving down" : "price sideways";
      entryCell = `<td class="hm-entry hm-dir" data-w="Dir" title="in position — ${tip}"><span class="hm-entry-icon"><span class="hm-dir-mount" data-dir="${dir}"></span></span></td>`;
    } else {
      entryCell = `<td class="hm-entry hm-entry-${entry.state}" data-w="Enter" title="${entry.title}"><span class="hm-entry-icon">${entry.icon}</span></td>`;
    }

    const rowHtml = `
      <td>${isOpen ? "📍" : idx + 1}</td>
      <td><span class="signals-price">#${escapeHtml(s.coin)}</span>${alignChip}</td>
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
  });

  // Добиваем таблицу пустыми строками до HM_MAX_ROWS, чтобы высота не прыгала
  // при малом числе монет (4 монеты → 4 пустышки). Плейсхолдеры — keyed (ph:N),
  // едут через тот же реконсилер, но БЕЗ enter/leave/FLIP-анимаций (см.
  // reconcileRows): монета въезжает в «освободившийся» пустой слот, пустышки не
  // мельтешат. Считаем по ОСНОВНЫМ строкам (enriched.length), под-строки позиции
  // (pos:) — отдельная намеренная высота, их не компенсируем.
  if (enriched.length === 0) {
    // Совсем нечего показать (ни позиции, ни прошедших фильтр монет). Раньше
    // тут выезжало 8 пустых строк — выглядело как «битая таблица». Вместо них
    // одна статус-строка: лоадер до первого снапшота, текст про WAIT в тишине.
    // Ключ ph:* → едет по no-animation пути реконсилера (чистый снос при данных).
    const loading = !payload?.ts;
    const statusHtml = loading
      ? '<span class="loader-spinner hm-status-spinner"></span><span>Loading…</span>'
      : "<span>quiet market — no movers</span>";
    items.push({
      key: "ph:status",
      cls: "hm-status-row",
      html: `<td colspan="11" class="hm-status-cell">${statusHtml}</td>`,
    });
  } else {
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
}

// Персистентные стрелки активной монеты: строки перестраиваются (innerHTML)
// каждый тик, поэтому переносим ОДИН и тот же DOM-узел стрелки в перестроенную
// ячейку (appendChild сохраняет identity). Стрелка показывает НАПРАВЛЕНИЕ ЦЕНЫ:
// вверх+зелёная = цена растёт, вниз+красная = падает. При смене направления
// плавно ПЕРЕВОРАЧИВАЕТСЯ (CSS-transition на rotate, см. _signals.scss).
// updateHotMoversLiveArrow() по живой цене (WS ≤2с) переключает up/down.
const _hmDirArrows = new Map(); // coin → <span.hm-dir-arrow>
const _hmDirUp = new Map(); // coin → bool (последнее направление) для гистерезиса
const _hmDirRef = new Map(); // coin → опорная цена (от неё мерим ход для флипа)

// Центрированная (вокруг 6,6) SVG-стрелка — переворот rotate(180°) идёт ровно,
// в отличие от текстового глифа ↑/↓ (не центрирован в em-боксе → вилял).
const _SVG_DIR_ARROW = `<svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"><path d="M6 2.5V9.5M3.2 5.3 6 2.5l2.8 2.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

// Направление цены с ГИСТЕРЕЗИСОМ (debounce): флипаем, только когда цена ушла от
// опорной точки больше чем на _DIR_BAND. Мелкая дрожь в полосе направление не
// меняет → стрелка не дёргается. Возвращает true(вверх)/false(вниз)/null(нет данных).
const _DIR_BAND = 0.001; // 0.1% — ход меньше считаем шумом
function dirUpForCoin(coin) {
  const now = getActivePos(coin)?.now;
  if (now == null || !Number.isFinite(now) || !(now > 0)) return null;
  const ref = _hmDirRef.get(coin);
  if (ref == null) {
    _hmDirRef.set(coin, now);
    return _hmDirUp.get(coin) ?? true;
  }
  const move = (now - ref) / ref;
  if (move > _DIR_BAND) {
    _hmDirRef.set(coin, now);
    _hmDirUp.set(coin, true);
    return true;
  }
  if (move < -_DIR_BAND) {
    _hmDirRef.set(coin, now);
    _hmDirUp.set(coin, false);
    return false;
  }
  return _hmDirUp.get(coin) ?? true; // в полосе → держим прошлое
}

function setArrowUp(arrow, up) {
  arrow.classList.toggle("up", up);
  arrow.classList.toggle("down", !up);
}

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
      arrow.innerHTML = _SVG_DIR_ARROW;
      const up = dirUpForCoin(coin) ?? mount.dataset.dir !== "down";
      _hmDirUp.set(coin, up);
      setArrowUp(arrow, up);
      _hmDirArrows.set(coin, arrow);
    }
    if (arrow.parentNode !== mount) mount.appendChild(arrow);
  }
  // Монета закрылась/ушла из таблицы — отпускаем узел (не копим Map).
  for (const coin of _hmDirArrows.keys())
    if (!seen.has(coin)) {
      _hmDirArrows.delete(coin);
      _hmDirUp.delete(coin);
      _hmDirRef.delete(coin);
    }
}

// Живой апдейт стрелки активной монеты — из onStatus по WS-status (≤2с). Считает
// направление цены (с гистерезисом) и переключает up/down; переворот анимирует CSS.
export function updateHotMoversLiveArrow() {
  for (const [coin, arrow] of _hmDirArrows) {
    const up = dirUpForCoin(coin);
    if (up == null) continue; // нет данных позиции — оставляем как есть
    setArrowUp(arrow, up);
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
