// ─────────────────────────────────────────────────
//  «А если взять троих?» — витрина предзаявленного форвардного теста.
//  Список заморожен 13.08.2026, правила в docs/winners-preregistration.md.
//
//  Витрина намеренно показывает ТРИ вещи рядом: результат выбранных, результат
//  контрольной группы и дату решения. Первое без второго — это история успеха,
//  а не измерение; без третьего — соблазн объявить победу в удачный день.
// ─────────────────────────────────────────────────

import { fetchJson } from "../net/api.js";
import { emptyRow, emptyState, settle } from "../core/placeholders.js";
import { icon } from "../core/icon.js";

const bp = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}` : "—");
const col = (v) =>
  !Number.isFinite(v) || v === 0 ? "" : `color:${v > 0 ? "var(--green)" : "var(--red)"}`;

const usd = (v) => {
  if (!Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const s = v < 0 ? "−" : "";
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${Math.round(a / 1e3)}k`;
  return `${s}$${Math.round(a)}`;
};

const short = (addr) => `${addr.slice(0, 8)}…${addr.slice(-4)}`;

const VERDICT_STYLE = {
  "confirmed": "var(--green)",
  "not confirmed": "var(--red)",
  "too early": "var(--text-muted)",
};

function renderRows(tbody, res) {
  settle(
    tbody,
    res.selected
      .map((s) => `<tr data-addr="${s.address}" style="cursor:pointer" title="click a row — what this address holds right now">
      <td style="font-family:var(--font-mono)"><span class="win-caret" data-addr="${s.address}" style="color:var(--text-muted);padding-right:4px">${icon("collapsed")}</span><a href="https://app.hyperliquid.xyz/explorer/address/${s.address}" target="_blank" rel="noopener" style="color:inherit">${short(s.address)}</a></td>
      <td class="r">${bp(s.selectionEdgeBp)}</td>
      <td class="r" style="${col(s.forwardEdgeBp)}">${s.forwardEdgeBp === null ? "<span style='color:var(--text-muted)'>no trades</span>" : bp(s.forwardEdgeBp)}</td>
      <td class="r" style="${col(s.forwardPnl)}">${s.forwardPnl === null ? "—" : usd(s.forwardPnl)}</td>
      <td class="r">${s.forwardVolume === null ? "—" : usd(s.forwardVolume)}</td>
    </tr>
    <tr class="win-pos" data-pos-for="${s.address}" hidden><td colspan="5" style="padding:0"></td></tr>`)
      .join(""),
  );
}

// ─── что у адреса открыто прямо сейчас ──────────────────────────────────────
//
// Это НАБЛЮДЕНИЕ, а не сигнал: заморозка списка держится на том, что вердикт
// считается по снимкам лидерборда и только на дату решения. Смотреть в чужие
// позиции полезно ровно для одного — увидеть, торгует адрес или сидит: у
// держателя лидерборд рисует прибыль, которой ещё нет.

let posCache = null;      // { fetchedAt, byAddr: Map }
let posPending = null;

async function loadPositions() {
  if (posCache && Date.now() - posCache.fetchedAt < posCache.ttl) return posCache;
  if (posPending) return posPending;
  posPending = (async () => {
    const res = await fetchJson("/api/winners/positions");
    if (!res?.ok) throw new Error(res?.reason || "no data");
    posCache = {
      fetchedAt: Date.now(),
      // Отдали прошлый ответ вместо свежего → держим кэш недолго, чтобы
      // следующий клик попробовал ещё раз.
      ttl: res.accounts.some((a) => a.stale || a.error) ? 10_000 : 60_000,
      byAddr: new Map(res.accounts.map((a) => [a.address, a])),
    };
    return posCache;
  })();
  try {
    return await posPending;
  } finally {
    posPending = null;
  }
}

const px = (v) =>
  !Number.isFinite(v) ? "—" : v >= 100 ? v.toFixed(2) : v >= 1 ? v.toFixed(4) : v.toPrecision(4);

// Возраст последнего удачного ответа. Пул HL при заторе штатно отказывает
// косметике (LOW ждёт бюджета 1.5с) — тогда показываем прошлый ответ с честной
// пометкой, сколько ему минут, а не пустую строку «не ответил».
const age = (ms) => {
  const min = Math.round(ms / 60_000);
  if (min < 1) return "less than a minute ago";
  if (min < 60) return `${min} min ago`;
  return `${Math.floor(min / 60)}h ${min % 60}m ago`;
};

function renderAccount(acc) {
  if (!acc) return "<div style='padding:6px 10px;color:var(--text-muted)'>address not found</div>";
  if (acc.error)
    return `<div style="padding:6px 10px;color:var(--text-muted)">no response: ${acc.error}</div>`;

  const staleNote = acc.stale
    ? ` · <span title="The HL request pool was busy with the live bot — this view waits at most 1.5s for budget and shows the previous answer">data from ${age(acc.staleAgeMs)}</span>`
    : "";

  if (!acc.positions.length)
    return `<div style="padding:6px 10px;color:var(--text-muted)">flat right now · equity ${usd(acc.equity)}${staleNote}</div>`;

  // Разбивка по площадкам: у HL кроме основного перп-DEX'а есть builder-DEX'ы
  // (xyz — акции и товары, и ещё восемь), у каждого своя маржа. Без этой строки
  // «эквити $47k» выглядит одним счётом, а это два разных.
  const venues = (acc.venues ?? []).filter((v) => v.positions || v.equity);
  const venueNote =
    venues.length > 1
      ? ` · accounts: ${venues.map((v) => `${v.dex} ${usd(v.equity)}`).join(" + ")}`
      : "";
  const partialNote = acc.partial
    ? ` · <span title="Could not list this address’s venues (userFills did not get budget) — showing the main DEX only">main DEX only</span>`
    : "";

  const head = `equity ${usd(acc.equity)} · notional ${usd(acc.notional)}` +
    (Number.isFinite(acc.grossLeverage) ? ` (${acc.grossLeverage.toFixed(1)}× of account)` : "") +
    ` · unrealized <b style="${col(acc.unrealizedPnl)}">${usd(acc.unrealizedPnl)}</b>` +
    venueNote + partialNote + staleNote;

  const rows = acc.positions
    .map((p) => `<tr>
      <td>${p.coin}</td>
      <td style="color:${p.side === "LONG" ? "var(--green)" : "var(--red)"}">${p.side}</td>
      <td class="r">${usd(p.sizeUsd)}</td>
      <td class="r">${p.leverage == null ? "—" : `${p.leverage}×`}${p.leverageType === "isolated" ? " iso" : ""}</td>
      <td class="r">${px(p.entryPrice)}</td>
      <td class="r" style="${col(p.unrealizedPnl)}">${usd(p.unrealizedPnl)}</td>
      <td class="r">${p.liquidationPrice == null ? "—" : px(p.liquidationPrice)}</td>
    </tr>`)
    .join("");

  return `<div style="padding:6px 10px;font-size: var(--fs-label);font-family:var(--font-mono)">
    <div style="color:var(--text-muted);margin-bottom:4px">${head}</div>
    <table class="data-table" style="margin:0">
      <thead><tr>
        <th>Coin</th><th>Side</th><th class="r">Size</th><th class="r">Lev</th>
        <th class="r">Entry</th><th class="r" title="Unrealized PnL — this is what the leaderboard PnL counts">Floating</th>
        <th class="r">Liq.</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>`;
}

function bindToggle(tbody) {
  if (tbody.dataset.winBound === "1") return;
  tbody.dataset.winBound = "1";
  tbody.addEventListener("click", async (e) => {
    // Ссылка на explorer внутри строки остаётся ссылкой — по ней не разворачиваем.
    if (e.target.closest("a")) return;
    const tr = e.target.closest("tr[data-addr]");
    if (!tr) return;
    const addr = tr.dataset.addr;
    const caret = tr.querySelector(".win-caret");
    const row = tbody.querySelector(`tr.win-pos[data-pos-for="${addr}"]`);
    if (!row) return;
    const cell = row.firstElementChild;
    if (!row.hidden) {
      row.hidden = true;
      if (caret) caret.innerHTML = icon("collapsed");
      return;
    }
    row.hidden = false;
    if (caret) caret.innerHTML = icon("expanded");
    // Скелетон, а не «…»: при заторе в пуле ответ приходит через секунду-две,
    // и за это время строка должна выглядеть загружающейся, а не сломанной.
    // Класс общий с остальным дашбордом (_loaders.scss).
    cell.innerHTML = `<div style="padding:8px 10px;display:flex;flex-direction:column;gap:6px">
      <div class="skeleton-row" style="width:45%;height:12px"></div>
      <div class="skeleton-row" style="width:80%"></div>
      <div class="skeleton-row" style="width:65%"></div>
    </div>`;
    try {
      const { byAddr } = await loadPositions();
      cell.innerHTML = renderAccount(byAddr.get(addr));
    } catch (err) {
      cell.innerHTML = `<div style="padding:6px 10px;color:var(--text-muted)">${err.message}</div>`;
    }
  });
}

function renderSummary(res) {
  const f = res.forward;
  const rows = [];

  if (f) {
    const beatsControl =
      Number.isFinite(f.selectedMedianBp) && Number.isFinite(f.controlMedianBp)
        ? f.selectedMedianBp > f.controlMedianBp
        : null;

    if (f.gap)
      rows.push(
        `<span style="color:var(--red)">${icon("warn")} Series broken:</span> ${f.gapNote} — the window is shorter than planned, the decision date is unchanged.`,
      );
    rows.push(
      `Forward ${f.from} → ${f.to} (${f.days} days): selected median <b style="${col(f.selectedMedianBp)}">${bp(f.selectedMedianBp)} bp</b> · ` +
      `control (${f.controlCount} addresses, same filters) <b style="${col(f.controlMedianBp)}">${bp(f.controlMedianBp)} bp</b>` +
      (beatsControl === null ? "" : beatsControl ? " → the selection is ahead so far" : " → the selection is not helping so far"),
    );
  } else {
    rows.push("Forward not computed yet: <code>node tools/winners.mjs track</code>");
  }

  rows.push(
    `Picked Aug 13 out of ${res.poolSize} addresses passing the filters (account ≥ $${(res.rules.minAccountValue / 1e3).toFixed(0)}k, ` +
    `turnover ≥ ${res.rules.minTurnover}× account, edge ≤ ${res.rules.maxPlausibleEdgeBp} bp) over the window ${res.selectionFrom}–${res.selectionTo}.`,
  );
  rows.push(
    `The interim look on ${res.interimDate} <b>decides nothing</b>. Decision date is <b>${res.decisionDate}</b>: ` +
    `it must beat the control AND clear +${res.successEdgeBp} bp, otherwise the hypothesis is closed.`,
  );
  rows.push(
    "Even a confirmation ≠ money: market makers cannot be copied (their profit is the spread), " +
    "fills are only visible after the fact, and on a thin edge fees eat the result first.",
  );

  return rows.map((r) => `<div>${r}</div>`).join("");
}

// ─── лента событий ──────────────────────────────────────────────────────────
//
// Отвечает на вопрос, которого нет ни в пуше, ни в таблице выше: что человек
// сделал и чем это кончилось. Две колонки — выиграл / проиграл — потому что
// именно их и спрашивают; всё остальное в строке события.
//
// ⛔ Вердикт теста здесь по-прежнему не считается. Это чтение постфактум.

const ago = (ms) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
};

const KIND = {
  open: { mark: icon("long"), label: "OPEN" },
  close: { mark: "×", label: "CLOSE" },
  flip: { mark: icon("recompute"), label: "FLIP" },
};

function renderLog(box, sumBox, res) {
  const { events, summary } = res;
  if (!events.length) {
    box.innerHTML = emptyState({
      glyph: "clock",
      title: "Nothing logged yet",
      hint: "The journal starts filling from the next event.",
    });
    if (sumBox) sumBox.textContent = "";
    return;
  }

  if (sumBox) {
    // Открытия в счёт не идут: у них исхода ещё нет.
    sumBox.innerHTML = summary.closed
      ? `won <b style="color:var(--green)">${summary.win}</b> / lost <b style="color:var(--red)">${summary.loss}</b> · ` +
        `net <b style="${col(summary.net)}">${usd(summary.net)}</b>`
      : "";
  }

  const now = Date.now();
  box.innerHTML = events
    .map((e) => {
      const k = KIND[e.kind] ?? KIND.open;
      const pnl =
        e.pnlNet === null || e.pnlNet === undefined
          ? e.kind === "open"
            ? ""
            : `<span style="color:var(--text-muted)">?</span>`
          : `<b style="${col(e.pnlNet)}">${e.pnlNet >= 0 ? "+" : ""}${usd(e.pnlNet)}</b>`;
      const held = e.heldMs ? `<span style="color:var(--text-muted)">${ago(e.heldMs)}</span>` : "";
      return `<div style="display:flex;gap:8px;padding:3px 0;border-bottom:1px solid var(--border-subtle,rgba(128,128,128,.12))">
        <span style="color:var(--text-muted);min-width:42px">${ago(now - e.ts)}</span>
        <span style="min-width:52px">${k.mark} ${k.label}</span>
        <span style="flex:1">${e.coin} <span style="color:var(--text-muted)">${e.side}${e.leverage ? ` ${e.leverage}×` : ""} ${usd(e.sizeUsd)}</span></span>
        ${held}
        <span style="min-width:60px;text-align:right">${pnl}</span>
        <span style="color:var(--text-muted)" title="${e.address}">${e.address.slice(0, 6)}…</span>
      </div>`;
    })
    .join("");
}

async function refreshLog() {
  const box = document.getElementById("win-log");
  const sumBox = document.getElementById("win-log-sum");
  if (!box) return;
  try {
    const res = await fetchJson("/api/winners/events?days=7&limit=200");
    if (!res?.ok) throw new Error(res?.reason || "no data");
    renderLog(box, sumBox, res);
  } catch (err) {
    box.innerHTML = emptyState({ glyph: "danger", title: "Could not load", hint: err.message });
  }
}

export async function refreshWinners() {
  const tbody = document.getElementById("win-tbody");
  const meta = document.getElementById("win-meta");
  const stats = document.getElementById("win-stats");
  if (!tbody) return;

  // Каждый отказ объясняется своими словами. Раньше все три печатали одну и
  // ту же короткую строку и в шапку, и в таблицу — «no data» одинаково
  // означало и «сеть легла», и «список ещё не заморожен».
  const fail = (metaText, { glyph, title, hint }) => {
    if (meta) meta.textContent = metaText;
    tbody.innerHTML = emptyRow(5, { glyph, title, hint });
    if (stats) stats.innerHTML = "";
  };

  let res;
  try {
    res = await fetchJson("/api/winners");
  } catch {
    fail("no connection", {
      glyph: "danger",
      title: "Dashboard is not answering",
      hint: "The frozen list could not be read. Reload the page to try again.",
    });
    return;
  }
  if (!res?.ok) {
    if (res?.reason === "not-frozen") {
      fail("list not frozen", {
        glyph: "clock",
        title: "The list is not frozen yet",
        hint: "Addresses are picked and locked once; until then there is nothing to measure forward.",
      });
    } else {
      fail("no data", {
        glyph: "info",
        title: "No data for this window",
        hint: "Nothing has been recorded for the frozen addresses yet.",
      });
    }
    return;
  }

  const verdict = res.forward?.verdict ?? "too early";
  if (meta) {
    meta.textContent = `verdict: ${verdict}`;
    meta.style.color = VERDICT_STYLE[verdict] ?? "var(--text-muted)";
  }
  renderRows(tbody, res);
  bindToggle(tbody);
  if (stats) stats.innerHTML = renderSummary(res);
  // Лента читается с диска и от /api/winners не зависит — её отказ не должен
  // гасить таблицу, поэтому запускается отдельно и свои ошибки ловит сама.
  refreshLog();
}
