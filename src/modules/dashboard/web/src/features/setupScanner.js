// ─────────────────────────────────────────────────
//  Setup Scanner (Swing) + Smart Signals — две связанные карточки.
//  · renderSetupScanner — медленная свинг-таблица (тренды 4h/1h, OI 7d, /60с).
//  · renderSmartSignals — топ-10 агрегатор (Candy Girl + Hot Movers + setup-rows
//    + BTC-макро/моментум).
//  Кросс-состояние (equity, hm-сигналы, BTC-momentum, tick-ready) проталкивается
//  из main через сеттеры — оно считается в tick()/WS-хендлере.
//  fmtTime передаётся в initSetupScanner (зависит от currentRangeHours в main).
// ─────────────────────────────────────────────────

import { escapeHtml, fmtUsd, fmtPrice } from "../utils/format.js";
import { fetchJson } from "../net/api.js";
import { getCandySignals } from "./candyGirl.js";
import { getActivePos } from "../state/activeCoins.js";

const SWING_RISK_PCT = 0.02; // риск на сделку = 2% equity (свинг-план размера)

// Живая цена активной (POS) монеты в Setup: предыдущая цена по coin → стрелка
// ↑/↓ + анимация при изменении. Питается из WS-status (≤2с), а не 60с-поллинга
// таблицы (см. updateSetupLivePrice ниже).
const _livePrevPx = new Map();

// ── Кросс-состояние, которое считает main (tick / WS) ──────────────
let _lastEquity = null; // последний известный equity (размер позиции в Swing-плане)
let _hmSignalsCache = []; // последние Hot Movers сигналы (для timing в Smart Signals)
let _btcMomentum1m = null; // BTC 1m momentum % (penalty при конфликте направления)
let _tickReady = false; // true после первого tick() — гейт против полупустых рендеров
// ── Внутреннее состояние Smart Signals ─────────────────────────────
let _lastSetupRowsCache = [];
let _macroPct = null;
let _macroFetchedAt = 0;
let _fmtTime = (ts) => String(ts);

export function setSwingEquity(v) {
  _lastEquity = v;
}
export function setHmSignals(arr) {
  _hmSignalsCache = arr;
}
export function setBtcMomentum1m(v) {
  _btcMomentum1m = v;
}
export function markTickReady() {
  _tickReady = true;
}
// Candy Girl дёргает Smart Signals при свежих сигналах, но только после первого
// tick() (иначе кэши hm/setup полупустые).
export function renderSmartSignalsIfReady() {
  if (_tickReady) renderSmartSignals();
}

export async function fetchMacroIfStale() {
  if (Date.now() - _macroFetchedAt < 5 * 60_000) return;
  try {
    const candles = await fetchJson("/api/candles?coin=BTC&interval=4h");
    if (Array.isArray(candles) && candles.length >= 2) {
      const last = candles[candles.length - 1];
      const prev = candles[candles.length - 2];
      const c = Number(last.c ?? last.close);
      const o = Number(prev.c ?? prev.close ?? prev.o);
      if (o && c) _macroPct = ((c - o) / o) * 100;
    }
    _macroFetchedAt = Date.now();
  } catch (_) {}
}

function _smartScoreSetup(r) {
  let s = 0;
  const fp = r.fundingPersist;
  if (
    fp?.fractionExtreme != null &&
    fp.fractionExtreme > 0.4 &&
    Math.abs(r.fundingApy || 0) > 50
  )
    s++;
  const oi = r.oi7d;
  if (
    oi?.deltaOi != null &&
    oi?.deltaPx != null &&
    oi.deltaOi > 0.5 &&
    Math.abs(oi.deltaPx) < 0.07
  )
    s++;
  if (r.premium != null && Math.abs(r.premium) > 0.001) s++;
  const vr = r.volRegime;
  if (vr?.ratio != null && vr.ratio > 1.5) s++;
  return s;
}

function _smartFmtPx(v) {
  if (v == null || !isFinite(Number(v))) return "—";
  const n = Number(v);
  if (n >= 10000) return `$${n.toFixed(0)}`;
  if (n >= 100) return `$${n.toFixed(1)}`;
  if (n >= 1) return `$${n.toFixed(3)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  if (n >= 0.0001) return `$${n.toFixed(5)}`;
  return `$${n.toFixed(6)}`;
}

export function renderSmartSignals() {
  const tbody = document.getElementById("smart-tbody");
  const macroEl = document.getElementById("smart-macro");
  if (!tbody) return;

  const macroDir =
    _macroPct == null
      ? "neutral"
      : _macroPct > 0.5
        ? "bull"
        : _macroPct < -0.5
          ? "bear"
          : "neutral";

  if (macroEl) {
    const macroLabel =
      _macroPct == null
        ? ""
        : `BTC 4h ${_macroPct > 0 ? "+" : ""}${_macroPct.toFixed(1)}% · ${macroDir === "bull" ? "▲ BULL" : macroDir === "bear" ? "▼ BEAR" : "● FLAT"}`;
    macroEl.dataset.macro = macroLabel;
    macroEl.style.color =
      macroDir === "bull"
        ? "var(--green)"
        : macroDir === "bear"
          ? "var(--red)"
          : "var(--text-muted)";
  }

  const TIER_SCORE = { STRONG: 3, NORMAL: 2, WEAK: 1 };
  const setupMap = new Map(
    (_lastSetupRowsCache || []).map((r) => [r.coin, _smartScoreSetup(r)]),
  );

  // BTC 1m momentum penalty: если BTC активно движется против направления сигнала
  const btcPressurePenalty = (dir) => {
    if (_btcMomentum1m == null) return 0;
    if (dir === "SHORT" && _btcMomentum1m > 0.3) return -4; // BTC памп → SHORT конфликт
    if (dir === "LONG" && _btcMomentum1m < -0.3) return -4; // BTC дамп → LONG конфликт
    return 0;
  };

  function macroBonus(dir) {
    if (macroDir === "neutral") return 0;
    if (dir === "LONG" && macroDir === "bull") return 2;
    if (dir === "SHORT" && macroDir === "bear") return 2;
    return -3; // conflict
  }
  function isConflict(dir) {
    const macroCon =
      (dir === "LONG" && macroDir === "bear") ||
      (dir === "SHORT" && macroDir === "bull");
    const momentumCon =
      _btcMomentum1m != null &&
      ((dir === "SHORT" && _btcMomentum1m > 0.5) ||
        (dir === "LONG" && _btcMomentum1m < -0.5));
    return macroCon || momentumCon;
  }

  const items = [];

  // CG signals — structured (entry/sl/tp/trend4h уже есть)
  for (const s of getCandySignals()) {
    const entry = Number(s.entry);
    const sl = Number(s.sl);
    const tp = Number(s.tp);
    const risk = Math.abs(sl - entry);
    const rr = risk > 0 ? (Math.abs(tp - entry) / risk).toFixed(1) : "2.0";
    const trendBonus =
      s.trend4h == null
        ? 0
        : s.direction === "LONG" && s.trend4h === "up"
          ? 2
          : s.direction === "SHORT" && s.trend4h === "down"
            ? 2
            : -1;
    const setupBonus = (setupMap.get(s.coin) || 0) * 2;
    const score =
      40 +
      Number(rr) * 3 +
      trendBonus +
      macroBonus(s.direction) +
      setupBonus +
      btcPressurePenalty(s.direction);
    items.push({
      coin: s.coin,
      direction: s.direction,
      entry,
      sl,
      tp,
      rr,
      trend4h: s.trend4h,
      score,
      why: [
        "CG",
        ...(setupMap.get(s.coin) >= 2 ? [`HL${setupMap.get(s.coin)}`] : []),
      ],
      conflict: isConflict(s.direction),
    });
  }

  // HM signals — рассчитываем entry/sl/tp из текущей цены
  for (const m of _hmSignalsCache) {
    if (!m.best?.tier || m.best.tier === "NEUTRAL") continue;
    const direction = m.best.side === "SHORT" ? "SHORT" : "LONG";
    const tierS = TIER_SCORE[m.best.tier] || 0;
    const setupBonus = (setupMap.get(m.coin) || 0) * 2;
    const existing = items.find((i) => i.coin === m.coin);
    if (existing) {
      existing.score += tierS * 3;
      if (!existing.why.includes("spike")) existing.why.push("spike");
    } else {
      const SL = 0.025;
      const entry = Number(m.price);
      const sl = direction === "SHORT" ? entry * (1 + SL) : entry * (1 - SL);
      const tp =
        direction === "SHORT" ? entry * (1 - SL * 2) : entry * (1 + SL * 2);
      const score =
        tierS * 3 +
        macroBonus(direction) +
        setupBonus +
        btcPressurePenalty(direction);
      items.push({
        coin: m.coin,
        direction,
        entry,
        sl,
        tp,
        rr: "2.0",
        trend4h: null,
        score,
        why: [
          "spike",
          ...(setupMap.get(m.coin) >= 2 ? [`HL${setupMap.get(m.coin)}`] : []),
        ],
        conflict: isConflict(direction),
      });
    }
  }

  // Setup-only — все монеты с mark price, без порога по score (watchlist fallback)
  for (const r of _lastSetupRowsCache) {
    if (items.find((i) => i.coin === r.coin)) continue;
    const ss = _smartScoreSetup(r);
    const direction = (r.fundingApy || 0) < 0 ? "LONG" : "SHORT";
    const entry = Number(r.mark || 0);
    if (!entry) continue;
    const SL = 0.025;
    const sl = direction === "SHORT" ? entry * (1 + SL) : entry * (1 - SL);
    const tp =
      direction === "SHORT" ? entry * (1 - SL * 2) : entry * (1 + SL * 2);
    // proxy score: |fundingApy| + funding persist fraction + OI delta
    const fp = r.fundingPersist;
    const oi = r.oi7d;
    let proxy = Math.min(Math.abs(r.fundingApy || 0) / 10, 5); // 0-5
    if (fp?.fractionExtreme != null) proxy += fp.fractionExtreme * 3;
    if (oi?.deltaOi != null) proxy += Math.abs(oi.deltaOi) * 2;
    if (r.premium != null) proxy += Math.abs(r.premium) * 200;
    const score = ss * 4 + proxy + macroBonus(direction);
    const why =
      ss > 0
        ? [`HL${ss}`, ...(Math.abs(r.fundingApy || 0) > 100 ? ["fund"] : [])]
        : Math.abs(r.fundingApy || 0) > 50
          ? ["fund"]
          : ["watch"];
    items.push({
      coin: r.coin,
      direction,
      entry,
      sl,
      tp,
      rr: "2.0",
      trend4h: null,
      score,
      why,
      conflict: isConflict(direction),
    });
  }

  items.sort((a, b) => b.score - a.score);
  const top10 = items.slice(0, 10);

  // Статус данных для мета-строки
  const collectorAgeH = _lastSetupRowsCache.reduce((mx, r) => {
    const age = r.fundingPersist?.ageHours ?? 0;
    return age > mx ? age : mx;
  }, 0);
  const dataReady = collectorAgeH >= 48;
  const dataLabel =
    collectorAgeH < 1
      ? "collecting…"
      : collectorAgeH < 24
        ? `warming up · ${collectorAgeH.toFixed(0)}h / 48h`
        : collectorAgeH < 48
          ? `almost ready · ${collectorAgeH.toFixed(0)}h / 48h`
          : collectorAgeH < 168
            ? `${collectorAgeH.toFixed(0)}h data · OI pending`
            : `${(collectorAgeH / 24).toFixed(0)}d data · full`;

  if (macroEl) {
    const parts = [
      macroEl.dataset.macro,
      `${_lastSetupRowsCache.length} coins · ${dataLabel}`,
    ].filter(Boolean);
    macroEl.textContent = parts.join(" · ");
  }

  if (!top10.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state">${dataLabel}</td></tr>`;
    return;
  }

  const TD =
    "padding:8px 10px;border-bottom:1px solid var(--hairline);vertical-align:middle;";
  const TDR = TD + "text-align:right;";
  const TDC = TD + "text-align:center;";

  tbody.innerHTML = top10
    .map((item, idx) => {
      const isLong = item.direction === "LONG";
      const dirHtml = isLong
        ? '<span style="color:var(--green);font-weight:700;font-family:var(--font-mono);font-size:12px">▲ LONG</span>'
        : '<span style="color:var(--red);font-weight:700;font-family:var(--font-mono);font-size:12px">▼ SHORT</span>';
      const trend4hHtml =
        item.trend4h == null
          ? '<span style="opacity:.35;font-family:var(--font-mono)">—</span>'
          : item.trend4h === "up"
            ? '<span style="color:var(--green);font-family:var(--font-mono)">▲</span>'
            : '<span style="color:var(--red);font-family:var(--font-mono)">▼</span>';
      // Один главный тег + опциональный score
      const LABEL_MAP = {
        CG: {
          text: "entry ready",
          style:
            "background:var(--accent-soft);color:var(--accent-strong);border:1px solid var(--accent-line)",
        },
        spike: {
          text: "spike",
          style:
            "background:var(--warn-soft);color:var(--warn);border:1px solid var(--warn)",
        },
        fund: {
          text: "funding",
          style:
            "background:var(--canvas-inset);color:var(--text-secondary);border:1px solid var(--border-muted)",
        },
        watch: {
          text: "watch",
          style:
            "background:none;color:var(--text-faint);border:1px solid var(--hairline)",
        },
        conflict: {
          text: "conflict",
          style:
            "background:none;color:var(--text-faint);border:1px solid var(--hairline)",
        },
      };
      const PRIORITY = ["CG", "spike", "fund"];
      const primary = item.conflict
        ? "conflict"
        : (PRIORITY.find((k) => item.why.includes(k)) ?? "watch");
      const lbl = LABEL_MAP[primary];
      const hlTag = item.why.find((w) => /^HL\d$/.test(w));
      const scoreHtml = hlTag
        ? `<span style="font-size:11px;padding:2px 6px;border-radius:3px;font-weight:600;background:var(--canvas-inset);color:var(--text-secondary);border:1px solid var(--border-muted)">${hlTag.replace("HL", "")} / 4</span>`
        : "";
      const whyHtml = `<span style="font-size:11px;padding:2px 6px;border-radius:3px;font-weight:600;${lbl.style}">${lbl.text}</span> ${scoreHtml}`;
      // Timing: ищем монету в HM — dump для LONG = момент входа, pump для SHORT
      const hm = _hmSignalsCache.find(
        (m) => m.coin === item.coin && m.best?.spikePct != null,
      );
      let timingHtml = `<span style="font-family:var(--font-mono);font-size:11px;color:var(--text-faint)">—</span>`;
      if (hm) {
        const spike = hm.best.spikePct;
        const goodForLong = isLong && spike < -1.5; // монета упала → хороший вход для лонга
        const goodForShort = !isLong && spike > 1.5; // монета пампит → хороший вход для шорта
        if (goodForLong) {
          timingHtml = `<span style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:#fff;background:var(--green);padding:2px 8px;border-radius:4px;white-space:nowrap">long now</span>`;
        } else if (goodForShort) {
          timingHtml = `<span style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:#fff;background:var(--red);padding:2px 8px;border-radius:4px;white-space:nowrap">short now</span>`;
        }
      }

      const rowOpacity = item.conflict ? "opacity:.45;" : "";
      const conflictIcon = item.conflict
        ? ' <span style="color:var(--red);font-size:10px" title="Macro conflict">⚠</span>'
        : "";
      const topGlow =
        idx === 0 && !item.conflict
          ? isLong
            ? "background:var(--green-soft);"
            : "background:var(--red-soft);"
          : "";
      return `<tr style="${rowOpacity}${topGlow}">
      <td style="${TD}font-family:var(--font-mono);color:var(--text-faint);font-size:11px">${idx + 1}</td>
      <td style="${TD}font-weight:700;font-size:14px">#${item.coin}${conflictIcon}</td>
      <td style="${TD}">${dirHtml}</td>
      <td style="${TDR}font-family:var(--font-mono);font-size:12px">${_smartFmtPx(item.entry)}</td>
      <td style="${TDR}font-family:var(--font-mono);font-size:12px;color:var(--red)">${_smartFmtPx(item.sl)}</td>
      <td style="${TDR}font-family:var(--font-mono);font-size:12px;color:var(--green)">${_smartFmtPx(item.tp)}</td>
      <td style="${TDR}font-family:var(--font-mono);font-size:12px">${item.rr}</td>
      <td style="${TDC}">${trend4hHtml}</td>
      <td style="${TD}display:flex;gap:3px;flex-wrap:wrap">${whyHtml}</td>
      <td style="${TDC}">${timingHtml}</td>
    </tr>`;
    })
    .join("");
}

function renderSetupScanner(payload) {
  const tbody = document.getElementById("setup-scanner-tbody");
  const meta = document.getElementById("setup-scanner-meta");
  if (!tbody || !meta) return;
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];

  if (!rows.length) {
    meta.textContent = "collecting first snapshots…";
    return; // skeleton остаётся до первых данных
  }
  document.getElementById("setup-scanner-skeleton")?.classList.add("hidden");

  // Сортировка: монеты с ОТКРЫТОЙ позицией всегда сверху, затем LONG/SHORT
  // (по силе), затем WAIT с посчитанным трендом, pending в самом низу.
  const rank = (r) => {
    const s = r.swing || {};
    if (s.pos) return 3;
    if (s.signal === "LONG" || s.signal === "SHORT") return 2;
    if (!s.pending) return 1;
    return 0;
  };
  const zoneRank = (r) => {
    const z = r.swing?.entryZone;
    return z === "zone" ? 2 : z === "mid" ? 1 : 0;
  };
  // Прячем строки без направления: WAIT/pending — это шум (90% таблицы).
  // Оставляем только actionable: открытая позиция (exit-контекст) или LONG/SHORT.
  const sorted = [...rows]
    .filter((r) => {
      const s = r.swing || {};
      return s.pos || s.signal === "LONG" || s.signal === "SHORT";
    })
    .sort((a, b) => {
      const d = rank(b) - rank(a);
      if (d) return d;
      // Среди сигналов: сначала те, где цена в зоне входа (actionable now)
      const dz = zoneRank(b) - zoneRank(a);
      if (dz) return dz;
      const ds = (b.swing?.strength || 0) - (a.swing?.strength || 0);
      if (ds) return ds;
      return (b.vol24hUsd || 0) - (a.vol24hUsd || 0);
    })
    .slice(0, 30);

  const pending = rows.filter((r) => r.swing?.pending).length;
  meta.textContent =
    `${sorted.length}/${rows.length} setups` +
    (pending ? ` · trends ${rows.length - pending}/${rows.length}` : "") +
    (payload?.ts ? ` · updated ${_fmtTime(payload.ts)}` : "");

  if (!sorted.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="empty-state">no directional setups — all coins in WAIT</td></tr>';
    return;
  }

  const arrowCell = (t) => {
    if (t === "up") return '<span style="color:var(--green)">↑</span>';
    if (t === "down") return '<span style="color:var(--red)">↓</span>';
    if (t === "none") return '<span class="num-inline-muted">−</span>';
    return '<span class="num-inline-muted">·</span>'; // тренд ещё считается
  };
  const badge = (sig) => {
    if (sig === "LONG") return '<span class="swing-badge long">LONG</span>';
    if (sig === "SHORT") return '<span class="swing-badge short">SHORT</span>';
    return '<span class="swing-badge wait">WAIT</span>';
  };
  // Entry-зона: где цена относительно 1h EMA20. zone = откат к EMA, ищи вход;
  // extended = растянута по тренду, не гнаться; mid = между. Тайминг (5m) — сам.
  // По монете с открытой позицией колонка превращается в exit-контекст.
  // Candy Girl = слой 5m-тайминга. ✓ = 5m reclaim по тренду подтверждён (вход
  // созрел); «…» = свинг даёт направление+зону, но 5m-вход ещё не напечатался.
  const candyChip = (s, showWait) => {
    if (s.candy?.confirmed)
      return ` <span class="swing-badge" style="background:rgba(236,72,153,.22);color:#ec4899;font-size:10px;padding:1px 6px;font-weight:700" title="Candy Girl: 5m reclaim по тренду подтверждён ${s.candy.ageMin}m назад — тайминг входа созрел">🍬 GO${s.candy.ageMin != null ? ` ${s.candy.ageMin}m` : ""}</span>`;
    if (showWait)
      return ` <span class="swing-badge" style="background:rgba(127,127,127,.12);color:var(--text-muted);font-size:10px;padding:1px 6px" title="Свинг даёт направление и зону, но Candy Girl ещё не подтвердил 5m-вход (reclaim не напечатался или радар выключен)">🍬 wait</span>`;
    return "";
  };
  const entryCell = (s) => {
    if (s.pos) {
      const t = escapeHtml(s.exitReason || "");
      if (s.exitLevel === "trend")
        return `<span style="color:var(--red);font-weight:700" title="${t}">⚠ exit?</span>`;
      if (s.exitLevel === "ema20")
        return `<span style="color:var(--orange, #f59e0b);font-weight:600" title="${t}">⚠ EMA20</span>`;
      return `<span style="color:var(--green)" title="${t}">hold</span>`;
    }
    const ext = s.ext1h;
    const extStr =
      ext != null ? `${ext >= 0 ? "+" : ""}${ext.toFixed(1)}%` : "";
    if (s.entryZone === "zone")
      return `<span style="color:var(--green);font-weight:600" title="Цена у 1h EMA20 (${extStr}) — зона отката, ищи вход по тренду">✓ zone</span>${candyChip(s, true)}`;
    if (s.entryZone === "extended")
      return `<span style="color:var(--orange, #f59e0b)" title="Цена растянута от 1h EMA20 (${extStr}) — гнаться поздно, жди отката">wait ${extStr}</span>`;
    if (s.entryZone === "mid")
      return `<span class="num-inline-muted" title="Цена между EMA20 и растяжкой (${extStr})">mid</span>${candyChip(s, false)}`;
    return '<span class="num-inline-muted">—</span>';
  };
  const posPill = (s) =>
    s.pos
      ? ` <span class="swing-badge ${s.pos === "long" ? "long" : "short"}" style="font-size:9px;padding:0 5px" title="Открытая позиция на счёте${s.entryPx ? ` · entry $${s.entryPx}` : ""}">POS·${s.pos === "long" ? "L" : "S"}</span>`
      : "";
  // Живой тикер цены для активной (POS) монеты: стрелка + цена, которые
  // обновляет updateSetupLivePrice() по WS-status. Текст наполняется при первом
  // апдейте; при полном ре-рендере таблицы (60с) ячейка пересоздаётся пустой и
  // тут же дозаполняется следующим status-пушем (≤2с).
  const liveCell = (r, s) =>
    s.pos
      ? ` <span class="setup-live" data-live-coin="${escapeHtml(r.coin)}" title="Живая цена (WS) — стрелка мигает при изменении"><span class="setup-live-arrow"></span><span class="setup-live-px"></span></span>`
      : "";
  // SL/TP-колонка (только POS-строки): дистанции от entry + R:R, читаемым размером.
  // Красным — нет стопа / стоп не с той стороны; оранжевым — R:R < 2 (правило 2:1).
  // Размер позиции для свинг-плана: риск = equity × 2%, size = риск / стоп-дист.
  const swingSizeUsd = (slPct) => {
    if (_lastEquity == null || !(slPct > 0)) return null;
    const riskUsd = Math.max(0.5, _lastEquity * SWING_RISK_PCT);
    return { size: riskUsd / (slPct / 100), riskUsd };
  };
  const slTpCell = (s) => {
    // Сигнал ДО входа (нет позиции): показываем план — стоп/таргет/2R + размер.
    if (!s.pos && (s.signal === "LONG" || s.signal === "SHORT") && s.plan) {
      const p = s.plan;
      const sz = swingSizeUsd(p.slPct);
      const sizeStr = sz ? ` · <span style="color:var(--text-secondary)">${fmtUsd(sz.size)}</span>` : "";
      const tip =
        `Стоп ${fmtPrice(p.sl)} (−${p.slPct.toFixed(1)}%) · TP ${fmtPrice(p.tp)} (+${p.tpPct.toFixed(1)}%) · ${p.rr}R` +
        (sz ? ` · размер ${fmtUsd(sz.size)} при риске ${fmtUsd(sz.riskUsd)} (2% депо)` : "");
      return `<span style="font-family:var(--font-mono);white-space:nowrap" title="${tip}"><span style="color:var(--red)">−${p.slPct.toFixed(1)}%</span> / <span style="color:var(--green)">+${p.tpPct.toFixed(1)}%</span> <span style="color:var(--green);font-weight:700">${p.rr}R</span>${sizeStr}</span>`;
    }
    if (!s.pos || !s.slTp) return '<span class="num-inline-muted">—</span>';
    const x = s.slTp;
    if (x.noSl)
      return '<span style="color:var(--red);font-weight:700">⚠ NO SL</span>';
    if (x.slWrongSide)
      return `<span style="color:var(--red);font-weight:700" title="SL $${x.sl} — не с той стороны от входа">⚠ SL?</span>`;
    const tip = `SL $${x.sl ?? "—"} · TP $${x.tp ?? "—"} · entry $${s.entryPx ?? "—"}`;
    const risk =
      x.riskPct != null
        ? `<span style="color:var(--red)">−${x.riskPct.toFixed(1)}%</span>`
        : `$${x.sl}`;
    const tp =
      x.tp == null
        ? '<span style="color:var(--orange, #f59e0b)">TP —</span>'
        : x.rewardPct != null
          ? `<span style="color:var(--green)">+${x.rewardPct.toFixed(1)}%</span>`
          : `$${x.tp}`;
    const rr =
      x.rr != null
        ? ` <span style="color:${x.rr < 2 ? "var(--orange, #f59e0b)" : "var(--green)"};font-weight:700">${x.rr.toFixed(1)}R</span>`
        : "";
    return `<span style="font-family:var(--font-mono);white-space:nowrap" title="${tip}">${risk} / ${tp}${rr}</span>`;
  };

  // Данные-колонки: OI/Px 7d (подсвечен, когда подтверждает сигнал), funding, vol.
  const fmtSignedPct = (v) =>
    v == null || !isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(0)}%`;
  const oiPxCell = (r, s) => {
    const oi = r.oi7d;
    if (!oi) return '<span class="num-inline-muted">—</span>';
    if (oi.etaHours != null)
      return `<span class="num-inline-muted" title="История копится">· ${(oi.etaHours / 24).toFixed(1)}d</span>`;
    const txt = `${fmtSignedPct(oi.deltaOi)} / ${fmtSignedPct(oi.deltaPx)}`;
    const confirms = s.signal === "LONG" || s.signal === "SHORT";
    return confirms
      ? `<span style="color:var(--accent);font-weight:600">${txt}</span>`
      : `<span class="num-inline-muted">${txt}</span>`;
  };
  const fundingCell = (apy) => {
    if (apy == null || !isFinite(apy)) return '<span class="num-inline-muted">—</span>';
    const HL_BASELINE_APY = 10.95;
    if (Math.abs(apy - HL_BASELINE_APY) < 2)
      return '<span class="num-inline-muted" title="≈ HL baseline (premium ≈ 0)">≈base</span>';
    const txt = `${apy >= 0 ? "+" : ""}${apy.toFixed(0)}%`;
    if (Math.abs(apy) > 30)
      return `<span style="color:var(--orange, #f59e0b);font-weight:600" title="Funding-экстрим — перекос позиций">${txt}</span>`;
    return `<span style="color:var(--text-muted)">${txt}</span>`;
  };
  const volCell = (vr) => {
    if (!vr || vr.ratio == null)
      return '<span class="num-inline-muted">—</span>';
    const v = vr.ratio;
    const color = v >= 2 ? "var(--red)" : v >= 1.5 ? "var(--orange, #f59e0b)" : v <= 0.5 ? "var(--text-faint)" : "var(--text-muted)";
    return `<span style="color:${color}">${v.toFixed(1)}×</span>`;
  };
  // Тинт всей строки по сигналу; ярче, когда цена в зоне входа.
  const rowCls = (s) => {
    const dir = s.signal === "LONG" ? "sw-long" : s.signal === "SHORT" ? "sw-short" : "";
    if (!dir) return "";
    return s.entryZone === "zone" || s.pos ? `${dir} sw-hot` : dir;
  };

  tbody.innerHTML = sorted
    .map((r) => {
      const s = r.swing || {};
      const det = [...(s.reasons || [])];
      if (r.fundingPersist?.fractionExtreme != null)
        det.push(`funding extreme ${(r.fundingPersist.fractionExtreme * 100).toFixed(0)}% of 48h`);
      return `<tr class="${rowCls(s)}" title="${escapeHtml(det.join(" · "))}">
      <td><span class="signals-price">#${escapeHtml(r.coin)}</span>${posPill(s)}${liveCell(r, s)}</td>
      <td class="c">${badge(s.signal)}</td>
      <td class="c">${arrowCell(s.trend4h)}&nbsp;${arrowCell(s.trend1h)}</td>
      <td class="c">${entryCell(s)}</td>
      <td class="c">${slTpCell(s)}</td>
      <td class="r">${oiPxCell(r, s)}</td>
      <td class="r">${fundingCell(r.fundingApy)}</td>
      <td class="r">${volCell(r.volRegime)}</td>
    </tr>`;
    })
    .join("");
}

// Живое обновление цены активной (POS) монеты — дёргается из WS-status (≤2с),
// независимо от 60с-поллинга свинг-таблицы. Для каждой POS-строки берёт текущую
// цену из стейта активных монет (getActivePos().now) и, если она изменилась,
// рисует стрелку ↑/↓ нужного цвета и ретригерит CSS-анимацию (короткий «спин»).
function fmtLivePx(px) {
  if (px == null || !Number.isFinite(px)) return "—";
  return px >= 100 ? px.toFixed(2) : px >= 1 ? px.toFixed(4) : px.toPrecision(4);
}
export function updateSetupLivePrice() {
  const tbody = document.getElementById("setup-scanner-tbody");
  if (!tbody) return;
  const cells = tbody.querySelectorAll(".setup-live[data-live-coin]");
  for (const cell of cells) {
    const coin = cell.getAttribute("data-live-coin");
    const px = getActivePos(coin)?.now;
    if (px == null || !Number.isFinite(px)) continue;
    const pxEl = cell.querySelector(".setup-live-px");
    const arrowEl = cell.querySelector(".setup-live-arrow");
    const prev = _livePrevPx.get(coin);
    if (pxEl) pxEl.textContent = `$${fmtLivePx(px)}`;
    if (prev != null && px !== prev && arrowEl) {
      const up = px > prev;
      arrowEl.textContent = up ? "↑" : "↓";
      arrowEl.classList.remove("up", "down", "pulse");
      // reflow → перезапуск анимации даже при подряд идущих тиках одной стороны.
      void arrowEl.offsetWidth;
      arrowEl.classList.add(up ? "up" : "down", "pulse");
    }
    _livePrevPx.set(coin, px);
  }
}

// Свинг-данные меняются медленно (тренды 4h/1h, OI 7d) — поллим раз в 60с.
// Каждый запрос дотягивает stale-тренды на бэке, поэтому первые минуты после
// рестарта часть строк «computing trend…» — это норма.
async function fetchSetupScanner() {
  try {
    renderSetupScanner(await fetchJson("/api/setup-scanner"));
  } catch (_) {
    /* best-effort: skeleton/прошлые данные остаются */
  }
}

// Инициализация: первичный fetch + 60с-поллинг. fmtTime зависит от
// currentRangeHours в main, поэтому передаётся ссылкой.
export function initSetupScanner({ fmtTime } = {}) {
  if (typeof fmtTime === "function") _fmtTime = fmtTime;
  fetchSetupScanner();
  setInterval(fetchSetupScanner, 60_000);
}
