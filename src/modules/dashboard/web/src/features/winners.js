// ─────────────────────────────────────────────────
//  «А если взять троих?» — витрина предзаявленного форвардного теста.
//  Список заморожен 13.08.2026, правила в docs/winners-preregistration.md.
//
//  Витрина намеренно показывает ТРИ вещи рядом: результат выбранных, результат
//  контрольной группы и дату решения. Первое без второго — это история успеха,
//  а не измерение; без третьего — соблазн объявить победу в удачный день.
// ─────────────────────────────────────────────────

import { fetchJson } from "../net/api.js";

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
  "подтверждено": "var(--green)",
  "не подтверждено": "var(--red)",
  "рано": "var(--text-muted)",
};

function renderRows(tbody, res) {
  tbody.innerHTML = res.selected
    .map((s) => `<tr data-addr="${s.address}" style="cursor:pointer" title="клик по строке — что у адреса открыто прямо сейчас">
      <td style="font-family:var(--font-mono)"><span class="win-caret" data-addr="${s.address}" style="color:var(--text-muted);padding-right:4px;font-size:10px">▸</span><a href="https://app.hyperliquid.xyz/explorer/address/${s.address}" target="_blank" rel="noopener" style="color:inherit">${short(s.address)}</a></td>
      <td class="r">${bp(s.selectionEdgeBp)}</td>
      <td class="r" style="${col(s.forwardEdgeBp)}">${s.forwardEdgeBp === null ? "<span style='color:var(--text-muted)'>не торговал</span>" : bp(s.forwardEdgeBp)}</td>
      <td class="r" style="${col(s.forwardPnl)}">${s.forwardPnl === null ? "—" : usd(s.forwardPnl)}</td>
      <td class="r">${s.forwardVolume === null ? "—" : usd(s.forwardVolume)}</td>
    </tr>
    <tr class="win-pos" data-pos-for="${s.address}" hidden><td colspan="5" style="padding:0"></td></tr>`)
    .join("");
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
    if (!res?.ok) throw new Error(res?.reason || "нет данных");
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
  if (min < 1) return "меньше минуты назад";
  if (min < 60) return `${min} мин назад`;
  return `${Math.floor(min / 60)}ч ${min % 60}м назад`;
};

function renderAccount(acc) {
  if (!acc) return "<div style='padding:6px 10px;color:var(--text-muted)'>адрес не найден</div>";
  if (acc.error)
    return `<div style="padding:6px 10px;color:var(--text-muted)">не ответил: ${acc.error}</div>`;

  const staleNote = acc.stale
    ? ` · <span title="Пул запросов HL был занят живым ботом — витрина ждёт бюджета не дольше 1.5с и показывает прошлый ответ">данные ${age(acc.staleAgeMs)}</span>`
    : "";

  if (!acc.positions.length)
    return `<div style="padding:6px 10px;color:var(--text-muted)">сейчас вне рынка · эквити ${usd(acc.equity)}${staleNote}</div>`;

  // Разбивка по площадкам: у HL кроме основного перп-DEX'а есть builder-DEX'ы
  // (xyz — акции и товары, и ещё восемь), у каждого своя маржа. Без этой строки
  // «эквити $47k» выглядит одним счётом, а это два разных.
  const venues = (acc.venues ?? []).filter((v) => v.positions || v.equity);
  const venueNote =
    venues.length > 1
      ? ` · счета: ${venues.map((v) => `${v.dex} ${usd(v.equity)}`).join(" + ")}`
      : "";
  const partialNote = acc.partial
    ? ` · <span title="Не удалось узнать список площадок адреса (userFills не дождался бюджета) — показан только основной DEX">смотрели только основной DEX</span>`
    : "";

  const head = `эквити ${usd(acc.equity)} · номинал ${usd(acc.notional)}` +
    (Number.isFinite(acc.grossLeverage) ? ` (${acc.grossLeverage.toFixed(1)}× к счёту)` : "") +
    ` · нереализованный <b style="${col(acc.unrealizedPnl)}">${usd(acc.unrealizedPnl)}</b>` +
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

  return `<div style="padding:6px 10px;font-size:11px;font-family:var(--font-mono)">
    <div style="color:var(--text-muted);margin-bottom:4px">${head}</div>
    <table class="data-table" style="margin:0">
      <thead><tr>
        <th>Монета</th><th>Сторона</th><th class="r">Размер</th><th class="r">Плечо</th>
        <th class="r">Вход</th><th class="r" title="Нереализованный PnL — он же и попадает в PnL лидерборда">Плавающий</th>
        <th class="r">Ликв.</th>
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
      if (caret) caret.textContent = "▸";
      return;
    }
    row.hidden = false;
    if (caret) caret.textContent = "▾";
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

    rows.push(
      `Форвард ${f.from} → ${f.to} (${f.days} дн.): медиана выбранных <b style="${col(f.selectedMedianBp)}">${bp(f.selectedMedianBp)} бп</b> · ` +
      `контроль (${f.controlCount} адресов, те же фильтры) <b style="${col(f.controlMedianBp)}">${bp(f.controlMedianBp)} бп</b>` +
      (beatsControl === null ? "" : beatsControl ? " → отбор пока впереди" : " → отбор пока не помогает"),
    );
  } else {
    rows.push("Форвард ещё не считался: <code>node tools/winners.mjs track</code>");
  }

  rows.push(
    `Отобраны 13.08 из ${res.poolSize} прошедших фильтры (счёт ≥ $${(res.rules.minAccountValue / 1e3).toFixed(0)}k, ` +
    `оборот ≥ ${res.rules.minTurnover}× счёта, эдж ≤ ${res.rules.maxPlausibleEdgeBp} бп) по окну ${res.selectionFrom}–${res.selectionTo}.`,
  );
  rows.push(
    `Промежуточный взгляд ${res.interimDate} <b>ничего не решает</b>. Дата решения — <b>${res.decisionDate}</b>: ` +
    `нужно обогнать контроль И превысить +${res.successEdgeBp} бп, иначе гипотеза закрывается.`,
  );
  rows.push(
    "⚠️ Даже подтверждение ≠ деньги: маркет-мейкеров скопировать нечем (прибыль в спреде), " +
    "сделки видны постфактум, а на тонком эдже комиссии съедают результат первыми.",
  );

  return rows.map((r) => `<div>${r}</div>`).join("");
}

export async function refreshWinners() {
  const tbody = document.getElementById("win-tbody");
  const meta = document.getElementById("win-meta");
  const stats = document.getElementById("win-stats");
  if (!tbody) return;

  const fail = (msg) => {
    if (meta) meta.textContent = msg;
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${msg}</td></tr>`;
    if (stats) stats.innerHTML = "";
  };

  let res;
  try {
    res = await fetchJson("/api/winners");
  } catch {
    fail("нет связи");
    return;
  }
  if (!res?.ok) {
    fail(res?.reason === "not-frozen" ? "список не заморожен" : "нет данных");
    return;
  }

  const verdict = res.forward?.verdict ?? "рано";
  if (meta) {
    meta.textContent = `вердикт: ${verdict}`;
    meta.style.color = VERDICT_STYLE[verdict] ?? "var(--text-muted)";
  }
  renderRows(tbody, res);
  bindToggle(tbody);
  if (stats) stats.innerHTML = renderSummary(res);
}
