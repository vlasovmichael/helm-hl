import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
// levels.html — зоны поддержки и сопротивления и план сделки от выбранной зоны.
// Страница не даёт сигналов: она говорит, где цена относительно зон и годна ли
// геометрия сделки от зоны.
// ─────────────────────────────────────────────────

import { bindTheme, startFooterTimer } from "./src/core/shell.js";
import { initReveal } from "./src/core/reveal.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
import { mountTopnav } from "./src/core/topnav.js";
import { segmented } from "./src/core/ui.js";
import { paintIcons } from "./src/core/icon.js";
import * as dialog from "./src/core/dialog.js";
import { skeletonText, skeletonRows, emptyState } from "./src/core/placeholders.js";
import { coinCombo, attachCoinCombo, cleanTicker, loadCoinUniverse } from "./src/core/coinCombo.js";
import { drawLevels, drawScene, applyLevelsTheme, tickPrice, setCandleMode } from "./src/charts/levelsChart.js";
import {
  startPriceStream,
  setWatchedCoins,
  onPriceTick,
  getLivePrice,
  coinKey,
} from "./src/net/priceStream.js";
import {
  readPrice,
  planFromZone,
  breakPlan,
  shownZones,
  scenarios,
  scenarioKey,
  renderRead,
  renderScenarios,
  renderContext,
  renderOi,
  renderPlan,
  renderSize,
  renderZones,
  SOURCE_NOTE,
} from "./src/features/levelPlan.js";
import { renderJournal, renderJournalSummary } from "./src/features/levelJournal.js";

mountTopnav("levels");
mountPageHeader({
  eyebrow: "Research · mechanical levels",
  title: "Levels",
  note: "Where price sits between the zones, and whether a trade from a zone pays.",
});
bindTheme([applyLevelsTheme]);
startFooterTimer();

const SIZE_KEY = "helm_lv_size";

function readSize() {
  try {
    const own = JSON.parse(localStorage.getItem(SIZE_KEY) || "null");
    if (own) return own;
    // Депо и риск уже вводились в калькуляторе журнала — не спрашивать дважды.
    const cj = JSON.parse(localStorage.getItem("helm_cj_calc") || "null");
    return cj ? { equity: cj.eq, risk: cj.risk } : {};
  } catch {
    return {};
  }
}

function saveSize(v) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify(v));
  } catch {
    /* приватное окно: размер просто не запомнится */
  }
}

// Цвет свечей — удобство одного зрителя, поэтому в браузере, а не в адресе.
const CANDLES_KEY = "helm_levels_candles";

function loadCandles() {
  try {
    return localStorage.getItem(CANDLES_KEY) === "color" ? "color" : "mono";
  } catch {
    return "mono";
  }
}

function saveCandles(mode) {
  try {
    localStorage.setItem(CANDLES_KEY, mode);
  } catch {
    /* приватное окно: выбор просто не запомнится */
  }
}

// Монета и ТФ из адреса: ссылкой можно поделиться ровно тем разбором.
const query = new URLSearchParams(location.search);

const state = {
  coin: query.get("coin") || "BTC",
  tf: ["15m", "1h", "4h"].includes(query.get("tf")) ? query.get("tf") : "1h",
  data: null,
  read: null,
  plan: null,
  coins: [],
  candles: loadCandles(),
};
setCandleMode(state.candles);

const el = (id) => document.getElementById(id);

function mountControls() {
  el("lv-coin").innerHTML = coinCombo({ id: "lv-coin-input", value: state.coin });
  attachCoinCombo(el("lv-coin-input"), {
    getCoins: () => state.coins,
    onPick: (c) => {
      state.coin = cleanTicker(c);
      load();
    },
  });

  el("lv-candles").innerHTML = segmented({
    name: "candles",
    value: state.candles,
    options: [
      { value: "mono", label: "B/W" },
      { value: "color", label: "Color" },
    ],
  });
  el("lv-candles").onclick = (e) => {
    const mode = e.target.closest("[data-candles]")?.dataset.candles;
    if (mode && mode !== state.candles) {
      state.candles = mode;
      saveCandles(mode);
      setCandleMode(mode);
      mountControls();
    }
  };

  el("lv-tf").innerHTML = segmented({
    name: "tf",
    value: state.tf,
    options: ["15m", "1h", "4h"].map((v) => ({ value: v, label: v })),
  });
  el("lv-tf").onclick = (e) => {
    const tf = e.target.closest("[data-tf]")?.dataset.tf;
    if (tf && tf !== state.tf) {
      state.tf = tf;
      mountControls();
      load();
    }
  };
}

function sizeInputs() {
  const num = (id) => parseFloat(String(el(id).value).replace(",", "."));
  return { equity: num("lv-equity"), riskPct: num("lv-risk") };
}

/** Смена плана проигрывает вход содержимого: видно, что числа сменились. */
function settleIn(node) {
  node.classList.remove("is-settling");
  void node.offsetWidth;
  node.classList.add("is-settling");
  node.addEventListener("animationend", () => node.classList.remove("is-settling"), { once: true });
}

function showPlan(plan) {
  const changed = scenarioKey(plan) !== scenarioKey(state.plan) || !plan;
  state.plan = plan;
  drawScene(shownZones(state.data, plan), plan, state.data?.thin || []);
  renderScenarios(el("lv-scenarios"), state.read, plan);
  renderPlan(el("lv-plan"), plan);
  renderSize(el("lv-size"), plan, sizeInputs());
  if (changed) {
    settleIn(el("lv-plan"));
    settleIn(el("lv-size"));
  }
}

const tableSkeleton = (cols, rows) =>
  `<table class="table table--compact"><tbody>${skeletonRows(cols, rows)}</tbody></table>`;
const chip = `<span class="sk sk-chip"></span>`;

// Форма будущего содержимого, чтобы макет не прыгал, когда данные встанут.
function showSkeletons() {
  el("lv-read").innerHTML = skeletonText(2);
  el("lv-scenarios").innerHTML = `<span class="sk sk-pill"></span>`.repeat(4);
  el("lv-plan").innerHTML = skeletonText(4);
  el("lv-size").innerHTML = skeletonText(2);
  el("lv-context").innerHTML = skeletonText(2);
  el("lv-oi").innerHTML = skeletonText(1);
  el("lv-zones").innerHTML = tableSkeleton(6, 6);
  el("lv-count").innerHTML = chip;
  // Живой график не сносим: на смене монеты он держит место до новых свечей.
  if (!el("lv-chart").firstChild) el("lv-chart").innerHTML = `<div class="sk sk-block"></div>`;
}

const LOAD_BLOCKS = ["lv-read", "lv-scenarios", "lv-plan", "lv-size", "lv-context", "lv-oi", "lv-zones"];

/** Вход играет только там, где стоял скелетон: тихие обновления не дёргаются. */
function waitingBlocks(ids) {
  return ids.filter((id) => el(id).querySelector(".sk"));
}

/** Вуаль поверх живого графика, пока едут свечи другой монеты или ТФ. */
function veilChart(on) {
  const box = el("lv-chart");
  box.querySelector(".local-loader")?.remove();
  if (on && !box.querySelector(".sk")) {
    box.insertAdjacentHTML("beforeend", `<div class="local-loader local-loader--veil"><div class="loader-spinner"></div></div>`);
  }
}

// Тихая перезагрузка на закрытии бара: без «Loading…», выбранный сценарий остаётся.
async function load({ quiet = false } = {}) {
  clearTimeout(barTimer);
  const node = el("lv-zones");
  const keep = quiet ? scenarioKey(state.plan) : "";
  if (!quiet) {
    veilChart(true);
    showSkeletons();
  }
  try {
    const r = await fetch(`/api/levels?coin=${encodeURIComponent(state.coin)}&tf=${state.tf}`);
    // Причину отказа показываем на странице: в консоли её видит только автор.
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `Request failed with status ${r.status}.`);
    }
    state.data = await r.json();
  } catch (err) {
    if (quiet && state.data) return scheduleBarClose();
    veilChart(false);
    state.data = null;
    node.innerHTML = emptyState({ glyph: "warn", title: "No levels for this coin", hint: err.message });
    if (el("lv-chart").querySelector(".sk")) el("lv-chart").innerHTML = "";
    el("lv-read").innerHTML = "";
    el("lv-scenarios").innerHTML = "";
    el("lv-context").innerHTML = "";
    el("lv-oi").innerHTML = "";
    el("lv-size").innerHTML = "";
    el("lv-plan").innerHTML = emptyState({ glyph: "info", title: "No data — nothing to plan" });
    el("lv-count").textContent = "";
    return;
  }

  setWatchedCoins([state.data.coin]);
  const waiting = waitingBlocks(LOAD_BLOCKS);
  const read = readPrice(state.data);
  state.read = read;
  renderRead(el("lv-read"), read, state.data.price);
  renderContext(el("lv-context"), state.data);
  renderOi(el("lv-oi"), state.data.coin, state.data.oi);
  await drawLevels(el("lv-chart"), state.data, (z) => showPlan(planFromZone(state.data, z)));
  veilChart(false);
  const kept = keep && scenarios(read).find((p) => scenarioKey(p) === keep);
  // У зоны план открыт сразу; посередине между зонами выбирать нечего.
  showPlan(kept || autoPlan(read));
  scheduleBarClose();
  renderZones(node, state.data);
  el("lv-count").textContent = `${state.data.zones.length} zones`;
  el("lv-sources").textContent = SOURCE_NOTE;
  waiting.forEach((id) => settleIn(el(id)));
  retrySeed();
  // Разбор записан сервером при этом запросе — журнал перечитывается после него.
  loadJournal();
}

// Прогрев EMA сервер грузит низким приоритетом, и бюджет HL может его отбросить:
// один тихий повтор на монету и ТФ, дальше ждём закрытия бара.
const SEED_RETRY_MS = 10_000;
let seedRetryKey = "";
let seedRetryTimer = null;

function retrySeed() {
  const key = `${state.data.coin}:${state.data.tf}`;
  if (state.data.emaSeed != null || seedRetryKey === key) return;
  seedRetryKey = key;
  clearTimeout(seedRetryTimer);
  seedRetryTimer = setTimeout(() => load({ quiet: true }), SEED_RETRY_MS);
}

function autoPlan(read) {
  return read.kind === "support" ? read.long : read.kind === "resistance" ? read.short : null;
}

// ── живая цена ──
// Тик двигает последнюю свечу и пересчитывает разбор; зоны и закрытые бары
// считает сервер, поэтому на закрытии бара страница перечитывается целиком.
const TF_SEC = { "15m": 900, "1h": 3600, "4h": 14400 };
const BAR_CLOSE_LAG_MS = 3_000;
const REPLAN_MS = 1_000;
let barTimer = null;
let replanTimer = null;

function barCloseAt() {
  const last = state.data?.candles?.at(-1);
  return last ? (last.time + TF_SEC[state.data.tf]) * 1000 : Infinity;
}

function scheduleBarClose() {
  clearTimeout(barTimer);
  const closeAt = barCloseAt();
  if (closeAt === Infinity) return;
  barTimer = setTimeout(() => load({ quiet: true }), Math.max(0, closeAt - Date.now()) + BAR_CLOSE_LAG_MS);
}

/** Тот же сценарий на новой цене: зона и сторона прежние, числа свежие. */
function samePlan(plan) {
  if (!plan) return null;
  return plan.kind === "break"
    ? breakPlan(state.data, plan.stopZone, plan.side)
    : planFromZone(state.data, plan.stopZone);
}

function replan() {
  replanTimer = null;
  if (!state.data) return;
  const read = readPrice(state.data);
  state.read = read;
  renderRead(el("lv-read"), read, state.data.price);
  showPlan(state.plan ? samePlan(state.plan) : autoPlan(read));
}

onPriceTick((changed) => {
  const coin = state.data?.coin;
  if (!coin || !changed.has(coinKey(coin))) return;
  const px = getLivePrice(coin);
  // Бар уже закрыт, новый ещё не пришёл с сервера: закрытую свечу не переписываем.
  if (!(px > 0) || Date.now() >= barCloseAt()) return;
  tickPrice(px);
  state.data.price = px;
  replanTimer ??= setTimeout(replan, REPLAN_MS);
});

// Бар мог закрыться, пока вкладка спала: таймер в фоне опаздывает.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && Date.now() >= barCloseAt()) load({ quiet: true });
});

// OI меняется быстрее свечей: строка перечитывается отдельно, график не трогается.
const OI_REFRESH_MS = 30_000;

async function refreshOi() {
  if (!state.data || document.hidden) return;
  const { coin, tf } = state.data;
  try {
    const r = await fetch(`/api/levels/oi?coin=${encodeURIComponent(coin)}&tf=${tf}`);
    if (!r.ok) return;
    const body = await r.json();
    if (state.data?.coin === coin) renderOi(el("lv-oi"), coin, body.oi);
  } catch {
    /* следующий проход перечитает */
  }
}

async function loadJournal() {
  if (!el("lv-journal-sum").firstChild) {
    el("lv-journal-sum").innerHTML = tableSkeleton(8, 3);
    el("lv-journal").innerHTML = tableSkeleton(5, 5);
    el("lv-journal-count").innerHTML = chip;
  }
  const waiting = waitingBlocks(["lv-journal-sum", "lv-journal"]);
  try {
    const r = await fetch("/api/levels/journal");
    if (!r.ok) throw new Error(`Request failed with status ${r.status}.`);
    const j = await r.json();
    renderJournalSummary(el("lv-journal-sum"), j);
    renderJournal(el("lv-journal"), j);
    el("lv-journal-count").textContent = `${j.open} waiting for outcome`;
    waiting.forEach((id) => settleIn(el(id)));
  } catch (err) {
    el("lv-journal-sum").innerHTML = emptyState({ glyph: "warn", title: "Journal did not load", hint: err.message });
    el("lv-journal").innerHTML = "";
    el("lv-journal-count").textContent = "";
  }
}

el("lv-scenarios").addEventListener("click", (e) => {
  const key = e.target.closest("[data-scenario]")?.dataset.scenario;
  const plan = state.read && scenarios(state.read).find((p) => scenarioKey(p) === key);
  if (plan) showPlan(plan);
});

for (const id of ["lv-equity", "lv-risk"]) {
  el(id).addEventListener("input", () => {
    saveSize({ equity: el("lv-equity").value, risk: el("lv-risk").value });
    renderSize(el("lv-size"), state.plan, sizeInputs());
  });
}

// Справка — в разметке страницы, диалог общий для дашборда.
el("lv-help-btn").addEventListener("click", () => {
  const help = el("lv-help").content;
  dialog.show({
    id: "lv-help-modal",
    wide: true,
    glyph: "help",
    title: help.querySelector("[data-help-title]").textContent,
    sub: help.querySelector("[data-help-sub]").textContent,
    body: help.querySelector("[data-help-body]").innerHTML,
  });
});
paintIcons(el("sec-lv-plan"));

setInterval(refreshOi, OI_REFRESH_MS);

const saved = readSize();
el("lv-equity").value = saved.equity ?? "";
el("lv-risk").value = saved.risk ?? "1";
mountControls();
loadCoinUniverse().then((coins) => {
  state.coins = coins;
});
startPriceStream();
load();
initReveal();
