// ─────────────────────────────────────────────────
//  Strategies — единый обзор всех стратегий (реестр-driven таблица /strategies).
//  Сортировка live→paper→radar→off, разворот строки → detail (сигналы радара +
//  постраничные сделки через REST). Приватный state: _stratExpanded (развёрнутые
//  строки), _stratTrades (REST-кэш сделок), _lastStrategies/_lastStrategiesHtml.
//  Экспорт: renderStrategies (WS + REST-поллинг из main дёргают её).
// ─────────────────────────────────────────────────

import { escapeHtml, fmtMoney, fmtUsd, fmtPrice } from "../utils/format.js";
import { fetchJson } from "../net/api.js";

const _stratExpanded = new Set(); // id'шники развёрнутых строк (переживают re-render)
let _lastStrategies = null;
let _lastStrategiesHtml = "";

const STRAT_STATUS = {
  live:    { label: "LIVE",    cls: "strat-live"    },
  paper:   { label: "PAPER",   cls: "strat-paper"   },
  radar:   { label: "RADAR",   cls: "strat-radar"   },
  off:     { label: "OFF",     cls: "strat-off"     },
  planned: { label: "PLANNED", cls: "strat-planned" },
};

function stratAge(ts) {
  if (!Number.isFinite(ts)) return "—";
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

// Мини-спарклайн кумулятивного P&L из серии net-сделок → inline SVG.
function stratSparkline(series) {
  if (!Array.isArray(series) || series.length < 2) return "";
  let cum = 0;
  const pts = series.map((n) => (cum += n));
  const min = Math.min(0, ...pts);
  const max = Math.max(0, ...pts);
  const range = max - min || 1;
  const w = 84, h = 22;
  const step = w / (pts.length - 1);
  const coords = pts.map((p, i) => {
    const x = (i * step).toFixed(1);
    const y = (h - ((p - min) / range) * h).toFixed(1);
    return `${x},${y}`;
  });
  const up = pts[pts.length - 1] >= 0;
  const color = up ? "var(--green, #3fb950)" : "var(--red, #f85149)";
  return (
    `<svg class="strat-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    `<polyline points="${coords.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5"/>` +
    `</svg>`
  );
}

function stratPnlCell(v) {
  if (!Number.isFinite(v) || v === 0) return `<td class="num strat-dim">${v === 0 ? "$0" : "—"}</td>`;
  const cls = v > 0 ? "strat-pos" : "strat-neg";
  return `<td class="num ${cls}">${fmtMoney(v)}</td>`;
}

const STRAT_TRADES_PER_PAGE = 10;
const _stratTrades = new Map(); // uid → { strategy, side, mode, page, total, trades, loading, error }

// Ленивая подгрузка страницы сделок стратегии (REST, не WS). Двойной рендер:
// сразу показываем loading, после ответа — данные. uid = идентичность строки
// (для split: candy_girl:long), strategy = базовый id, side = фильтр стороны.
async function loadStratTrades(uid, strategy, side, mode, page) {
  _stratTrades.set(uid, { ...(_stratTrades.get(uid) || {}), strategy, side, mode, page, loading: true });
  renderStrategies(_lastStrategies, true);
  try {
    const r = await fetchJson(
      `/api/strategy-trades?strategy=${encodeURIComponent(strategy)}&mode=${mode}` +
        (side ? `&side=${side}` : "") +
        `&limit=${STRAT_TRADES_PER_PAGE}&offset=${page * STRAT_TRADES_PER_PAGE}`,
    );
    _stratTrades.set(uid, { strategy, side, mode, page, total: r.total ?? 0, trades: r.trades ?? [], loading: false });
  } catch {
    _stratTrades.set(uid, { strategy, side, mode, page, total: 0, trades: [], loading: false, error: true });
  }
  renderStrategies(_lastStrategies, true);
}

function stratTradesBlock(s) {
  const tc = _stratTrades.get(s.uid);
  if (!tc || tc.loading) {
    return `<div class="strat-detail-block strat-detail-full"><div class="strat-detail-h">Recent trades</div><div class="strat-dim">loading…</div></div>`;
  }
  if (tc.error) {
    return `<div class="strat-detail-block strat-detail-full"><div class="strat-detail-h">Recent trades</div><div class="strat-neg">не удалось загрузить</div></div>`;
  }
  const trades = tc.trades || [];
  if (!trades.length) {
    return `<div class="strat-detail-block strat-detail-full"><div class="strat-detail-h">Recent trades</div><div class="empty-state">no closed trades yet</div></div>`;
  }
  const rows = trades
    .map((t) => {
      const net = (t.realized_pnl || 0) - (t.fee_paid || 0);
      const cls = net > 0 ? "strat-pos" : net < 0 ? "strat-neg" : "strat-dim";
      const side = (t.side || "").toUpperCase();
      const held = t.hold_seconds ? stratHold(t.hold_seconds) : "";
      return (
        `<tr><td class="strat-dt-coin">${escapeHtml(t.coin)}</td>` +
        `<td class="strat-dt-side">${side}</td>` +
        `<td class="num ${cls}">${fmtMoney(net)}</td>` +
        `<td class="strat-dt-reason strat-dim">${escapeHtml(t.reason || "")}</td>` +
        `<td class="num strat-dim">${held}</td>` +
        `<td class="num strat-dim strat-dt-age">${stratAge(t.closed_at)} ago</td></tr>`
      );
    })
    .join("");
  const pages = Math.max(1, Math.ceil(tc.total / STRAT_TRADES_PER_PAGE));
  const pager =
    pages > 1
      ? `<div class="strat-pager">` +
        `<button class="strat-pg-btn" data-uid="${s.uid}" data-strategy="${s.id}" data-side="${s.side || ""}" data-mode="${tc.mode}" data-page="${tc.page - 1}" ${tc.page <= 0 ? "disabled" : ""}>‹</button>` +
        `<span class="strat-pg-info">${tc.page + 1}/${pages} · ${tc.total} trades</span>` +
        `<button class="strat-pg-btn" data-uid="${s.uid}" data-strategy="${s.id}" data-side="${s.side || ""}" data-mode="${tc.mode}" data-page="${tc.page + 1}" ${tc.page >= pages - 1 ? "disabled" : ""}>›</button>` +
        `</div>`
      : `<div class="strat-pg-info">${tc.total} trade${tc.total === 1 ? "" : "s"}</div>`;
  return (
    `<div class="strat-detail-block strat-detail-full">` +
    `<div class="strat-detail-h">Recent trades</div>` +
    `<table class="strat-detail-table"><tbody>${rows}</tbody></table>${pager}</div>`
  );
}

function stratDetail(s) {
  const parts = [];
  // Сигналы радара (Candy Girl / Chill Boy) — из WS-payload (in-memory, лёгкие).
  const sigs = Array.isArray(s.signals) ? s.signals : [];
  if (sigs.length) {
    const rows = sigs
      .map((sig) => {
        const dir = (sig.direction || "").toUpperCase();
        const arrow = dir === "LONG" ? "▲" : dir === "SHORT" ? "▼" : "•";
        const dcls = dir === "LONG" ? "strat-pos" : dir === "SHORT" ? "strat-neg" : "strat-dim";
        return (
          `<tr><td class="strat-dt-coin">${escapeHtml(sig.coin || "")}</td>` +
          `<td class="strat-dt-side ${dcls}">${arrow} ${dir}</td>` +
          `<td class="num strat-dim">${fmtPrice(sig.price)}</td>` +
          `<td class="num strat-dim strat-dt-age">${stratAge(sig.ts || sig.at || sig.time)} ago</td></tr>`
        );
      })
      .join("");
    parts.push(
      `<div class="strat-detail-block"><div class="strat-detail-h">Recent signals</div>` +
        `<table class="strat-detail-table"><tbody>${rows}</tbody></table></div>`,
    );
  }
  // Сделки — постранично через REST-кэш.
  parts.push(stratTradesBlock(s));
  return `<div class="strat-detail">${parts.join("")}</div>`;
}

// Длительность удержания в человекочитаемом виде.
function stratHold(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  if (sec < 3600) return `${Math.round(sec / 60)}m`;
  if (sec < 86400) return `${(sec / 3600).toFixed(1)}h`;
  return `${(sec / 86400).toFixed(1)}d`;
}

function stratRowHtml(s, planned) {
  const st = STRAT_STATUS[s.status] || STRAT_STATUS.off;
  const dim = planned || s.status === "off" ? " strat-row-dim" : "";

  if (planned) {
    return (
      `<tr class="strat-row strat-row-planned${dim}" data-id="${s.uid}">` +
      `<td class="strat-col-name"><div class="strat-name">${escapeHtml(s.label)}</div>` +
      `<div class="strat-kind">${escapeHtml(s.kind || "")}</div></td>` +
      `<td><span class="strat-pill ${st.cls}">${st.label}</span></td>` +
      `<td colspan="11" class="strat-dim">— зарезервировано под будущую стратегию —</td></tr>`
    );
  }

  const e = s.edge || {};
  const pos = s.active
    ? `<span class="strat-pos-coin">${escapeHtml(s.active.coin)}</span> ` +
      `<span class="strat-${s.active.side === "LONG" ? "pos" : "neg"}">${s.active.side}</span>` +
      ` <span class="strat-dim">${s.active.heldHours.toFixed(1)}h</span>`
    : '<span class="strat-dim">—</span>';

  const equity = s.virtual
    ? `${fmtUsd(s.virtual.equity)} <span class="${s.virtual.pnlTotal >= 0 ? "strat-pos" : "strat-neg"} strat-eq-pct">${(s.virtual.pnlPct * 100).toFixed(1)}%</span>`
    : '<span class="strat-dim">—</span>';

  const trades = e.trades ?? 0;
  const winPct = trades > 0 ? `${(e.winRate * 100).toFixed(0)}%` : "—";
  const exp = Number.isFinite(e.expectancy)
    ? `<span class="${e.expectancy >= 0 ? "strat-pos" : "strat-neg"}">${fmtMoney(e.expectancy)}</span>`
    : "—";
  const payoff = Number.isFinite(e.payoff)
    ? `<span class="${e.payoff >= 2 ? "strat-pos" : e.payoff < 1 ? "strat-neg" : ""}">${e.payoff.toFixed(2)}</span>`
    : "—";
  const maxdd = Number.isFinite(e.maxDd) && e.maxDd < 0
    ? `<span class="strat-neg">${fmtMoney(e.maxDd)}</span>`
    : '<span class="strat-dim">—</span>';

  const expanded = _stratExpanded.has(s.uid);
  const main =
    `<tr class="strat-row${dim}${expanded ? " is-expanded" : ""}" data-id="${s.uid}" tabindex="0">` +
    `<td class="strat-col-name"><div class="strat-name">${escapeHtml(s.label)} ` +
    `<span class="strat-caret">${expanded ? "▾" : "▸"}</span></div>` +
    `<div class="strat-kind">${escapeHtml(s.kind || "")}</div></td>` +
    `<td><span class="strat-pill ${st.cls}">${st.label}</span></td>` +
    `<td>${pos}</td>` +
    `<td class="num">${equity}</td>` +
    `<td class="num">${trades}</td>` +
    `<td class="num">${winPct}</td>` +
    `<td class="num">${exp}</td>` +
    `<td class="num">${payoff}</td>` +
    `<td class="num">${maxdd}</td>` +
    stratPnlCell(s.pnl?.day) +
    stratPnlCell(s.pnl?.week) +
    stratPnlCell(s.pnl?.all) +
    `<td class="strat-col-spark">${stratSparkline(s.spark)}</td></tr>`;

  const detail = expanded
    ? `<tr class="strat-detail-row" data-detail="${s.uid}"><td colspan="13">${stratDetail(s)}</td></tr>`
    : "";
  return main + detail;
}

export function renderStrategies(payload, force) {
  const tbody = document.getElementById("strategies-tbody");
  if (!tbody || !payload) return;

  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  const planned = Array.isArray(payload.planned) ? payload.planned : [];

  // Сортировка: live → paper → radar → off; внутри по |all P&L|.
  const order = { live: 0, paper: 1, radar: 2, off: 3 };
  const sorted = [...rows].sort((a, b) => {
    const so = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (so !== 0) return so;
    return Math.abs(b.pnl?.all || 0) - Math.abs(a.pnl?.all || 0);
  });

  const html =
    sorted.map((s) => stratRowHtml(s, false)).join("") +
    planned.map((s) => stratRowHtml(s, true)).join("");

  // WS шлёт статус каждые ~1-2с. Если отрендеренный HTML не изменился — НЕ трогаем
  // DOM: иначе перестройка tbody под курсором сбрасывает :hover (строка «дрожит»).
  // force=true для разворота detail по клику (HTML меняется — нужно перерисовать).
  if (force || html !== _lastStrategiesHtml || !tbody.children.length) {
    _lastStrategiesHtml = html;
    tbody.innerHTML = html;
  }

  // Сводка в шапке: сколько live / paper / radar.
  const summary = document.getElementById("strategies-summary");
  if (summary) {
    const count = (st) => rows.filter((r) => r.status === st).length;
    const sumHtml =
      `<span class="strat-pill strat-live">${count("live")} live</span>` +
      `<span class="strat-pill strat-paper">${count("paper")} paper</span>` +
      `<span class="strat-pill strat-radar">${count("radar")} radar</span>`;
    if (summary.innerHTML !== sumHtml) summary.innerHTML = sumHtml;
  }

  // Клик по строке → разворот detail (делегирование навешиваем один раз).
  if (!tbody._stratBound) {
    tbody._stratBound = true;
    const toggle = (uid) => {
      if (!uid) return;
      if (_stratExpanded.has(uid)) {
        _stratExpanded.delete(uid);
      } else {
        _stratExpanded.add(uid);
        // При разворачивании — подгружаем свежую страницу сделок (REST).
        const row = (_lastStrategies?.rows || []).find((r) => (r.uid || r.id) === uid);
        loadStratTrades(uid, row?.id || uid, row?.side || null, row?.statMode || "PAPER", 0);
      }
      renderStrategies(_lastStrategies, true);
    };
    tbody.addEventListener("click", (ev) => {
      // Кнопки пагинации внутри detail — обрабатываем ДО toggle.
      const pg = ev.target.closest(".strat-pg-btn");
      if (pg && !pg.disabled) {
        ev.stopPropagation();
        loadStratTrades(
          pg.dataset.uid, pg.dataset.strategy, pg.dataset.side || null,
          pg.dataset.mode, parseInt(pg.dataset.page, 10) || 0,
        );
        return;
      }
      const row = ev.target.closest(".strat-row:not(.strat-row-planned)");
      if (row) toggle(row.getAttribute("data-id"));
    });
    tbody.addEventListener("keydown", (ev) => {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      const row = ev.target.closest(".strat-row:not(.strat-row-planned)");
      if (row) { ev.preventDefault(); toggle(row.getAttribute("data-id")); }
    });
  }
  _lastStrategies = payload;
}
