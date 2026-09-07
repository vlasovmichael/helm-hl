import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
//  movers.html — сканер Hot Movers и карточка Chasing. Обе про ход монеты, но
//  на разных шкалах: сканер «куда смотреть» (2м/5м/15м, WS), Chasing «за эту
//  сторону журнал уже заплатил» (15м/1ч/24ч). Сведённые в строку они спорят.
// ─────────────────────────────────────────────────

import {
  fmtTime,
  bindTheme,
  initWebSocket,
  startFooterTimer,
} from "./src/core/shell.js";
import { mountTopnav } from "./src/core/topnav.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
import { paintIcons, icon } from "./src/core/icon.js";
import { emptyState, settle } from "./src/core/placeholders.js";
import { fetchJson } from "./src/net/api.js";
import { updateActiveCoinSet } from "./src/state/activeCoins.js";
import {
  renderHotMovers,
  updateHotMoversLiveArrow,
} from "./src/hotMovers/render.js";
import { initManualPaperTrigger } from "./src/features/manualPaper.js";
import { initWhatIf } from "./src/features/whatif.js";

mountPageHeader({
  status: true,
  eyebrow: "Movers",
  title: "What is moving · and whether you are late",
});
mountTopnav("movers");
bindTheme();

// ── Hot Movers ──
// WS шлёт hotMovers каждые ~2с. Пока поток живой, HTTP-фолбэк не дёргаем —
// это были бы те же данные вторым путём.
const WS_HOTMOVERS_FRESH_MS = 8000;
let lastWsHotMoversAt = 0;

initWebSocket({
  onStatus: (data) => {
    // Открытые позы нужны рендеру: свою монету он пинит наверх и ведёт живой
    // стрелкой, даже когда её момент уже не в топе.
    updateActiveCoinSet(data.activePosition, data.manualPositions);
    if (data.hotMovers?.signals) {
      renderHotMovers(data.hotMovers, fmtTime);
      lastWsHotMoversAt = Date.now();
    }
    updateHotMoversLiveArrow();
  },
});

// Фолбэк на случай молчания сокета: те же данные по HTTP.
setInterval(() => {
  if (document.hidden) return;
  if (Date.now() - lastWsHotMoversAt < WS_HOTMOVERS_FRESH_MS) return;
  fetchJson("/api/signals?limit=30")
    .then((d) => { if (d?.signals) renderHotMovers(d, fmtTime); })
    .catch(() => {});
}, 10_000);

// ── Chasing ──
// Карточка не выбирает монету и не предлагает вход: она помечает сторону, за
// которую журнал уже заплатил (вход в сторону случившегося движения). Молчание
// фильтра — это молчание, а не разрешение.
const EF_LVL_LABEL = { extreme: "extreme", strong: "strong", fast: "fast 15m", quiet: "quiet" };

function efPct(v, digits = 1) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function efRenderBody(data) {
  const body = document.getElementById("ef-body");
  const rows = data.rows || [];
  if (!rows.length) {
    body.innerHTML = emptyState({
      glyph: "clock",
      title: "Not enough price history yet",
      hint: "The filter needs about an hour of ticks after a restart before it can judge a move.",
    });
    return;
  }

  const held = data.holdingBlocked || [];
  const verdict = held.length
    ? {
        cls: "warn",
        head: `You are in ${held.map((h) => `${h.position.side} ${h.coin}`).join(", ")} — entered with the move`,
        detail: held
          .map((h) => `${h.coin}: ${h.text}. In the journal this side averaged −0.18 per trade; the extreme slice −0.49.`)
          .join(" "),
      }
    : data.flagged
      ? {
          cls: "calm",
          head: `${data.flagged} of ${data.scanned} coins are running hard right now`,
          detail: "No open position sits on the flagged side. The table below marks which side would be an entry into a move that already happened — it does not suggest the opposite side as a trade.",
        }
      : {
          cls: "calm",
          head: "Nothing is running hard — the filter is silent",
          detail: "No coin exceeds 3% on the hour or 1.5% on 15 minutes. Silence means the journal has nothing to say here, not that an entry is good.",
        };

  const trs = rows
    .map((r) => {
      const side = r.blockedSide
        ? `<span class="ef-side ${r.blockedSide.toLowerCase()}">${icon(r.blockedSide === "SHORT" ? "short" : "long")}${r.blockedSide}</span>`
        : `<span class="ef-side none">—</span>`;
      const pos = r.position
        ? `<span class="ef-side ${r.position.side.toLowerCase()}">${icon(r.position.side === "SHORT" ? "short" : "long")}${r.position.side}</span>`
        : `<span class="oi-muted">—</span>`;
      return `<tr class="${r.holdingBlocked ?"ef-held" : ""}">
        <td>${r.coin}</td>
        <td>${efPct(r.trend15m)}</td>
        <td>${efPct(r.trend1h)}</td>
        <td>${efPct(r.dayChangePct)}</td>
        <td>${side}</td>
        <td><span class="ef-lvl ${r.level}">${EF_LVL_LABEL[r.level] || r.level}</span></td>
        <td>${pos}</td>
      </tr>`;
    })
    .join("");

  settle(
    body,
    `
    <div class="ef-verdict ${verdict.cls}">
      <div class="ef-vh">${verdict.head}</div>
      <div class="ef-vd">${verdict.detail}</div>
    </div>
    <div class="ef-table-wrap">
      <table class="ef-t">
        <thead>
          <tr>
            <th>Coin</th><th>15m</th><th>1h</th><th>24h</th>
            <th data-card="Side that would be an entry into the move that already happened">Costly side</th>
            <th>Move</th>
            <th data-card="Your open position on the exchange">You hold</th>
          </tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>
    </div>`,
  );
}

function efRenderForward(data) {
  const el = document.getElementById("ef-fwd");
  const fw = data.forward;
  if (!fw || fw.n == null) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<b>Forward check:</b> <b>${fw.n}</b> of <b>${fw.target}</b> fresh trades logged since the hypothesis
    was registered. The rule was found in past data, so it is judged <b>once</b>, at ${fw.target} — looking earlier
    is what turned five previous ideas into noise.`;
}

// Карточка живёт сама, как Hot Movers: тренды 1ч/15м берутся из price-буфера в
// памяти, поэтому опрос ничего не стоит бирже. «reading…» только на первой
// отрисовке — иначе meta мигает раз в 15 секунд.
const EF_POLL_MS = 15_000;
let efLoaded = false;

async function loadEntryFilter() {
  const meta = document.getElementById("ef-meta");
  if (!efLoaded) meta.textContent = "reading…";
  try {
    const data = await fetchJson("/api/entry-filter");
    if (data.error) throw new Error(data.error);
    meta.textContent = data.marketAgeSec == null ? "" : `market ${data.marketAgeSec}s old · ${data.scanned} coins · live`;
    efRenderBody(data);
    efRenderForward(data);
    efLoaded = true;
  } catch (err) {
    meta.textContent = "error";
    // Уже нарисованную таблицу сетевой сбой не стирает: следующий опрос через
    // 15с сам её оживит, а пустой экран вместо данных — худшее из состояний.
    if (efLoaded) return;
    document.getElementById("ef-body").innerHTML = emptyState({
      glyph: "danger",
      title: "Could not load the filter",
      hint: `${err.message}. Retrying every ${EF_POLL_MS / 1000}s.`,
    });
  }
}

// DEV-мок без бэка: ?mock=hm — тики Hot Movers, порядок монет меняется каждые
// 2с. На нём смотрят движение таблицы (живые тики иначе только с бэка).
// &pos=SOL,BTC — открытые позиции: с ними у строк появляются под-строки, на
// которых и проверяется высота карточки.
if (new URLSearchParams(location.search).get("mock") === "hm") {
  const pos = (new URLSearchParams(location.search).get("pos") || "")
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  import("./src/dev/mockHotMovers.js").then((m) =>
    m.startHotMoversMock({ positions: pos }),
  );
}

// <i data-icon="…"> в статической разметке → настоящие svg.
paintIcons();
initManualPaperTrigger("mp-paper-btn");
initWhatIf();

loadEntryFilter();
setInterval(loadEntryFilter, EF_POLL_MS);
startFooterTimer();
