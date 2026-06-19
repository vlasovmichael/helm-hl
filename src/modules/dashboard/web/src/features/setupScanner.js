// ─────────────────────────────────────────────────
//  Setup Scanner (Swing) — медленная свинг-таблица (тренды 4h/1h, OI 7d, /60с).
//  Equity проталкивается из main через setSwingEquity (для размера позиции в плане).
//  fmtTime передаётся в initSetupScanner (зависит от currentRangeHours в main).
//  (Smart Signals удалён 2026-06-19 — мёртвый агрегатор без эджа, см. memory.)
// ─────────────────────────────────────────────────

import { escapeHtml, fmtUsd, fmtPrice } from "../utils/format.js";
import { popArrow, bindArrowPopEnd } from "../utils/arrowPop.js";
import { fetchJson } from "../net/api.js";
import { getActivePos } from "../state/activeCoins.js";

const SWING_RISK_PCT = 0.02; // риск на сделку = 2% equity (свинг-план размера)

// Живая цена активной (POS) монеты в Setup: предыдущая цена по coin → стрелка
// ↑/↓ + анимация при изменении. Питается из WS-status (≤2с), а не 60с-поллинга
// таблицы (см. updateSetupLivePrice ниже).
const _livePrevPx = new Map();

let _lastEquity = null; // последний известный equity (размер позиции в Swing-плане)
let _fmtTime = (ts) => String(ts);

export function setSwingEquity(v) {
  _lastEquity = v;
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
    if (prev != null && px !== prev && prev > 0 && arrowEl) {
      bindArrowPopEnd(arrowEl);
      const deltaPct = (Math.abs(px - prev) / prev) * 100;
      popArrow(arrowEl, px > prev, deltaPct);
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
