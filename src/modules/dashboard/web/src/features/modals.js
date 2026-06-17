// ─────────────────────────────────────────────────
//  Модалки + Activity-лента.
//  · Help modal — mini-FAQ по карточкам (HELP_CONTENT расширяемый, по data-help).
//  · Trade detail modal — клик по событию в Activity → разбор сделки (+ дозагрузка
//    деталей через /api/trade/:id).
//  · renderActivity — лента последних событий (open/close), кликабельные строки.
//  initModals() вешает один делегированный document-listener на обе модалки +
//  activity-клик + Escape. Экспорт: renderActivity, initModals.
// ─────────────────────────────────────────────────

import {
  strategyDisplayName,
  escapeHtml,
  fmtSince,
  fmtNotional,
} from "../utils/format.js";
import { fetchJson } from "../net/api.js";

let lastActivityEvents = [];

// Источник сделки → бейдж. bot = бот сам открыл+закрыл; adopted = я вошёл,
// бот подхватил выход (adopt-нянька); manual = вход и выход мои.
const SOURCE_META = {
  bot: { label: "BOT", cls: "src-bot" },
  adopted: { label: "ADOPTED", cls: "src-adopted" },
  manual: { label: "MANUAL", cls: "src-manual" },
};

function eventSource(e) {
  if (e.source) return e.source;
  if (e.strategy_id === "adopt") return "adopted";
  if (e.kind === "manual_close" || e.strategy_id === "manual") return "manual";
  return "bot";
}

function reasonLabel(reason) {
  if (!reason) return "";
  return String(reason).replace(/_/g, " ");
}

export function renderActivity(activity) {
  const container = document.getElementById("activity-container");
  if (!container) return; // нет секции (напр. /strategies.html)
  const events = (activity?.events || []).filter((e) => e && e.coin);
  lastActivityEvents = events;
  if (!events.length) {
    container.innerHTML = '<div class="empty-state">No events</div>';
    return;
  }
  container.innerHTML = events
    .map((e, idx) => {
      const isOpen = e.kind === "open";
      const kindLabel = isOpen ? "OPEN" : "CLOSE";
      const kindClass = isOpen ? "open" : "close";

      const src = eventSource(e);
      const sm = SOURCE_META[src] || SOURCE_META.bot;
      const srcBadge = `<span class="src-badge ${sm.cls}" title="${strategyDisplayName(
        e.strategy_id,
      )}">${sm.label}</span>`;

      const side = (e.side || "").toUpperCase();
      const sideChip = side
        ? `<span class="side-chip side-${side.toLowerCase()}">${side}</span>`
        : "";

      const reason = !isOpen && e.reason
        ? `<span class="activity-reason">${escapeHtml(reasonLabel(e.reason))}</span>`
        : "";

      const metaBits = [];
      if (Number.isFinite(e.sizeUsd) && e.sizeUsd > 0)
        metaBits.push(fmtNotional(e.sizeUsd));
      if (Number.isFinite(e.ts)) metaBits.push(`${fmtSince(e.ts)} ago`);
      const meta = metaBits.length
        ? `<span class="activity-meta">${metaBits.join(" · ")}</span>`
        : "";

      let pnlCell;
      if (isOpen) {
        pnlCell = '<span class="activity-pnl dim">open</span>';
      } else {
        const pnlVal = e.pnl || 0;
        pnlCell = `<span class="activity-pnl ${
          pnlVal >= 0 ? "positive" : "negative"
        }">${pnlVal >= 0 ? "+" : ""}${pnlVal.toFixed(2)}</span>`;
      }

      const canOpen =
        e.kind === "close" || e.kind === "manual_close" || e.kind === "open";
      const clickable = canOpen ? "clickable" : "";
      const idxAttr = canOpen ? `data-activity-idx="${idx}"` : "";
      return `
      <div class="activity-item ${clickable}" ${idxAttr}>
        <span class="activity-kind ${kindClass}">${kindLabel}</span>
        <span class="activity-coin">#${escapeHtml(e.coin)}</span>
        ${sideChip}
        ${srcBadge}
        ${reason}
        ${meta}
        ${pnlCell}
      </div>`;
    })
    .join("");
}

// ── Help modal (mini FAQ per card) ─────────────────────────────────────
const HELP_CONTENT = {
  setupScanner: {
    title: "Setup Scanner · Swing — направление на 1+ день",
    lead: "Биас/контекст для ручного свинга, НЕ команда на вход. Направление задаёт тренд (4h главный + 1h подтверждение), OI подтверждает реальность движения, funding — флаг осторожности. Вход и инвалидацию ставишь сам.",
    sections: [
      {
        title: "Сигнал v1",
        rows: [
          [
            '<span class="swing-badge long">LONG</span>',
            "4h↑ + 1h↑, OI растёт вместе с ценой за 7д (реальный спрос), funding не в эйфории",
          ],
          [
            '<span class="swing-badge short">SHORT</span>',
            "4h↓ + 1h↓, OI растёт на падении (давят шорты), funding не в панике",
          ],
          [
            '<span class="swing-badge wait">WAIT</span>',
            "Тренды разошлись, OI не подтверждает или funding в экстриме. Подробности — в tooltip строки",
          ],
        ],
      },
      {
        title: "Тренд 4h / 1h",
        sub: "Позиция цены и EMA20 относительно медленной EMA (200 на 1h, 50 на 4h — те же ~200 часов). ↑ = цена и EMA20 выше; ↓ = ниже; − = смешанно. Связь с фейдом: 4h range (−) → фейд ок; чёткий 4h тренд → фейд против него = самоубийство.",
      },
      {
        title: "Позиция открыта — exit-контекст",
        sub: "Монеты с открытой позицией на счёте (ручной или ботовой) поднимаются в топ с бейджем POS, Entry-колонка показывает контекст удержания, колонка SL/TP — твои стопы с биржи: дистанции от входа + R:R (оранжевый если R:R < 2, красный ⚠ NO SL если стопа нет). Дублируется ntfy-пушем (тихий час 00–08: пуш беззвучный).",
        rows: [
          ['<span style="color:var(--green)">hold</span>', "Тренд за позицию — контекст не против тебя"],
          [
            '<span style="color:#f59e0b">⚠ EMA20</span>',
            "Цена закрепилась за 1h EMA20 против позиции — импульс теряется",
          ],
          [
            '<span style="color:var(--red)">⚠ exit?</span>',
            "1h тренд развернулся против позиции — контекст сломан. Не команда: проверь график и свой стоп",
          ],
        ],
      },
      {
        title: "Entry — можно ли прямо сейчас",
        sub: "Сигнал = направление, Entry = тайминг. Где цена относительно 1h EMA20 (зоны отката). Вход в зону тоже дублируется ntfy-пушем:",
        rows: [
          [
            '<span style="color:var(--green);font-weight:600">✓ zone</span>',
            "Цена у/за EMA20 — откат случился, ищи вход по тренду (5m reclaim — глазами)",
          ],
          [
            '<span class="num-inline-muted">mid</span>',
            "Между зоной и растяжкой — можно ждать лучшую цену",
          ],
          [
            '<span style="color:#f59e0b">wait −3.2%</span>',
            "Цена растянута от EMA20 по тренду — гнаться поздно (chase), жди отката",
          ],
          [
            '<span style="color:#ec4899;font-weight:700">🍬 GO 12m</span>',
            "Candy Girl подтвердил 5m reclaim по тому же направлению (≤90m назад) — тайминг входа созрел. «🍬 wait» = свинг даёт зону, но 5m-вход ещё не напечатался (или радар выключен)",
          ],
        ],
      },
      {
        title: "Источник данных",
        sub: "Scout раз в 60min (SETUP_SNAPSHOT_INTERVAL_MIN) пишет snapshot по всем монетам из liquidSet (top-50 по 24h vol) в setup_snapshots. Retention 90 дней. HL не отдаёт историю — копим сами с нуля.",
      },
      {
        title: "Funding APY",
        sub: "Annualized funding (current). > +30% APY = шортов перебор, < -30% = лонгов перебор. Сам по себе шум; ценен в комбо с persist.",
      },
      {
        title: "Premium",
        sub: "Mark vs oracle. > 0 = mark выше oracle (давление покупателей), < 0 = давление продавцов. Доли %, не путать с funding.",
      },
      {
        title: "Persist 48h",
        sub: "Доля 48ч-сэмплов с |APY| > 30%. Funding extreme который ДЕРЖИТСЯ ≥48ч = устойчивая разбалансировка позиций, не разовый всплеск.",
        rows: [
          [
            '<span style="color:var(--red)">≥80% extreme</span>',
            "Перенасыщенная сторона — высокая вероятность сжатия (squeeze)",
          ],
          ['<span style="color:#f59e0b">40-80%</span>', "Заметное смещение"],
          [
            '<span class="num-inline-muted">collecting · Xh</span>',
            "Недостаточно истории, ждём 48ч",
          ],
        ],
      },
      {
        title: "OI Δ7d / Px",
        sub: "Δ Open Interest vs Δ цены за 7 дней. Главный setup-маркер: OI растёт сильно, а цена стоит → накапливают позицию, ждут катализатор.",
        rows: [
          [
            '<span style="color:var(--accent)">+50% / +2%</span>',
            "Massive accumulation без движения — high-conviction setup",
          ],
          [
            "+10% / +30%",
            "OI просто следует за ценой — нормальный тренд, не setup",
          ],
          [
            '<span class="num-inline-muted">collecting · Xd</span>',
            "Ждём 7 дней истории",
          ],
        ],
      },
      {
        title: "Vol regime",
        sub: "Vol 24h / средний 24h vol за 30d. > 1.5× = регулярный объём вырос (рост интереса). < 0.5× = монета остыла. Нужно 30 дней истории.",
      },
      {
        title: "Почему нет суммарного score 0-4",
        sub: "Пока persist/OI/regime ещё «collecting» — суммарный балл будет враньём. Показываем сигналы по отдельности и красим только те, что готовы. Через ~30 дней появится полноценный score.",
      },
    ],
  },
};

function renderHelpSection(s) {
  let html = `<div class="help-section">`;
  html += `<div class="help-section-title">${s.title}</div>`;
  if (s.sub) html += `<div class="help-section-sub">${s.sub}</div>`;
  if (Array.isArray(s.rows) && s.rows.length) {
    html += `<table class="help-table"><tbody>`;
    for (const r of s.rows) {
      html += `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`;
    }
    html += `</tbody></table>`;
  }
  html += `</div>`;
  return html;
}

function openHelpModal(key) {
  const content = HELP_CONTENT[key];
  const modal = document.getElementById("help-modal");
  const body = document.getElementById("help-modal-body");
  if (!content || !modal || !body) return;
  body.innerHTML =
    `<div class="help-modal__title">${content.title}</div>` +
    (content.lead
      ? `<div class="help-modal__lead">${content.lead}</div>`
      : "") +
    content.sections.map(renderHelpSection).join("");
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}

function closeHelpModal() {
  const modal = document.getElementById("help-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

// ── Trade detail modal ─────────────────────────────────────────────────
function openTradeModal(html) {
  const modal = document.getElementById("trade-modal");
  const body = document.getElementById("trade-modal-body");
  if (!modal || !body) return;
  body.innerHTML = html;
  modal.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeTradeModal() {
  const modal = document.getElementById("trade-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.style.overflow = "";
}

function tmHeader({ coin, side, kindLabel, strat, isManual, when }) {
  const sideClass = side === "LONG" ? "long" : side === "SHORT" ? "short" : "";
  const sideChip = side
    ? `<span class="tm-side-chip ${sideClass}">${side === "LONG" ? "▲" : "▼"} ${side}</span>`
    : "";
  // strategyDisplayName('manual') уже отдаёт '🖐 Manual' — не дублируем эмодзи.
  const stratText =
    isManual && !/manual/i.test(strat) ? `${strat} · 🖐 Manual` : strat;
  return `
    <div class="tm-header">
      <div class="tm-coin-badge">${coin.slice(0, 4)}</div>
      <div class="tm-header-text">
        <div class="tm-title">${kindLabel} #${coin} ${sideChip}</div>
        <div class="tm-sub">${stratText} · ${when}</div>
      </div>
    </div>
  `;
}

function tmPnlHero(pnl) {
  const cls = pnl >= 0 ? "positive" : "negative";
  const sign = pnl >= 0 ? "+" : "−";
  return `
    <div class="tm-pnl-hero">
      <div class="tm-pnl-hero-label">Realized PnL</div>
      <div class="tm-pnl-hero-value ${cls}">${sign}$${Math.abs(pnl).toFixed(4)}</div>
    </div>
  `;
}

function tradeModalHtmlFromActivity(e) {
  const kindLabel = e.kind === "open" ? "OPEN" : "CLOSE";
  const isManual = e.kind === "manual_close" || e.strategy_id === "manual";
  const strat = strategyDisplayName(e.strategy_id);
  const pnl = e.pnl || 0;
  const when = new Date(e.ts).toLocaleString();
  const side = e.side ? e.side.toUpperCase() : null;

  const cells = [];
  if (e.entryPrice != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Entry</div><div class="tm-cell-value">$${fmtPx(e.entryPrice)}</div></div>`,
    );
  if (e.closePrice != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Close</div><div class="tm-cell-value">$${fmtPx(e.closePrice)}</div></div>`,
    );
  if (e.sizeUsd != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Size</div><div class="tm-cell-value">$${e.sizeUsd.toFixed(2)}</div></div>`,
    );
  if (e.reason)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Reason</div><div class="tm-cell-value">${e.reason}</div></div>`,
    );

  return `
    ${tmHeader({ coin: e.coin, side, kindLabel, strat, isManual, when })}
    ${e.kind !== "open" ? tmPnlHero(pnl) : ""}
    ${cells.length ? `<div class="tm-grid">${cells.join("")}</div>` : ""}
    ${e.id ? `<div class="tm-section" id="tm-detail-slot"><div class="tm-section-title">Детали</div><div class="tm-sub">Загружаю…</div></div>` : ""}
  `;
}

function tradeDetailHtml(t) {
  if (!t) return '<div class="tm-sub">Детали недоступны</div>';
  const strat = strategyDisplayName(t.strategy_id);
  const direction = (t.side || t.direction || "long").toUpperCase();
  const entryPx = t.entry_price;
  const closePx = t.close_price;
  const pnl = t.realized_pnl || 0;
  const fee = t.fee_paid || 0;
  const grossPnl = pnl + fee;
  const holdMs =
    t.closed_at && t.entry_time ? t.closed_at - t.entry_time : null;
  const holdStr =
    holdMs == null
      ? "—"
      : holdMs < 60_000
        ? `${Math.round(holdMs / 1000)}s`
        : holdMs < 3600_000
          ? `${Math.round(holdMs / 60_000)}m`
          : `${(holdMs / 3600_000).toFixed(1)}h`;
  const sl = t.sl_price;
  const tp = t.tp_price;
  const opened = t.entry_time ? new Date(t.entry_time).toLocaleString() : "—";
  const closed = t.closed_at ? new Date(t.closed_at).toLocaleString() : "—";
  const isManual = t.strategy_id === "manual";

  const cells = [
    `<div class="tm-cell"><div class="tm-cell-label">Entry</div><div class="tm-cell-value">$${fmtPx(entryPx)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Close</div><div class="tm-cell-value">$${fmtPx(closePx)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Size</div><div class="tm-cell-value">$${(t.size_usd || 0).toFixed(2)}</div></div>`,
    `<div class="tm-cell"><div class="tm-cell-label">Hold</div><div class="tm-cell-value">${holdStr}</div></div>`,
  ];
  if (sl != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Stop Loss</div><div class="tm-cell-value">$${fmtPx(sl)}</div></div>`,
    );
  if (tp != null)
    cells.push(
      `<div class="tm-cell"><div class="tm-cell-label">Take Profit</div><div class="tm-cell-value">$${fmtPx(tp)}</div></div>`,
    );
  cells.push(
    `<div class="tm-cell"><div class="tm-cell-label">Gross PnL</div><div class="tm-cell-value ${grossPnl >= 0 ? "positive" : "negative"}">${grossPnl >= 0 ? "+" : "−"}$${Math.abs(grossPnl).toFixed(4)}</div></div>`,
  );
  cells.push(
    `<div class="tm-cell"><div class="tm-cell-label">Fees</div><div class="tm-cell-value muted">−$${Math.abs(fee).toFixed(4)}</div></div>`,
  );
  if (t.reason)
    cells.push(
      `<div class="tm-cell full"><div class="tm-cell-label">Close reason</div><div class="tm-cell-value">${t.reason}</div></div>`,
    );

  return `
    ${tmHeader({ coin: t.coin, side: direction, kindLabel: "TRADE", strat, isManual, when: `id ${t.id}` })}
    ${tmPnlHero(pnl)}
    <div class="tm-grid">${cells.join("")}</div>
    <div class="tm-section">
      <div class="tm-section-title">Timeline</div>
      <div class="tm-grid">
        <div class="tm-cell"><div class="tm-cell-label">Opened</div><div class="tm-cell-value muted">${opened}</div></div>
        <div class="tm-cell"><div class="tm-cell-label">Closed</div><div class="tm-cell-value muted">${closed}</div></div>
      </div>
    </div>
  `;
}

function fmtPx(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.01 ? 5 : 7;
  return v.toFixed(digits);
}

async function onActivityClick(e) {
  const row = e.target.closest("[data-activity-idx]");
  if (!row) return;
  const idx = parseInt(row.getAttribute("data-activity-idx"), 10);
  const evt = lastActivityEvents[idx];
  if (!evt) return;
  openTradeModal(tradeModalHtmlFromActivity(evt));
  if (evt.id) {
    try {
      const r = await fetchJson(`/api/trade/${evt.id}`);
      const slot = document.getElementById("tm-detail-slot");
      if (slot && r?.trade)
        slot.outerHTML = `<div class="tm-section">${tradeDetailHtml(r.trade)}</div>`;
    } catch (err) {
      const slot = document.getElementById("tm-detail-slot");
      if (slot)
        slot.innerHTML =
          '<div class="tm-sub">Не удалось загрузить детали</div>';
    }
  }
}

// Один делегированный listener на обе модалки + activity-клик + Escape.
export function initModals() {
  document.addEventListener("click", (e) => {
    if (e.target.closest("#trade-modal [data-close]")) {
      closeTradeModal();
      return;
    }
    if (e.target.closest("#help-modal [data-close]")) {
      closeHelpModal();
      return;
    }
    const helpBtn = e.target.closest(".help-btn[data-help]");
    if (helpBtn) {
      openHelpModal(helpBtn.dataset.help);
      return;
    }
    if (e.target.closest("#activity-container")) onActivityClick(e);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeTradeModal();
      closeHelpModal();
    }
  });
}
