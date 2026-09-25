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
import { coinCombo, attachCoinCombo, cleanTicker, loadCoinUniverse } from "./src/core/coinCombo.js";
import { drawLevels, drawScene, applyLevelsTheme } from "./src/charts/levelsChart.js";
import {
  readPrice,
  planFromZone,
  shownZones,
  renderRead,
  renderContext,
  renderOi,
  renderPlan,
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

// Монета и ТФ из адреса: ссылкой можно поделиться ровно тем разбором.
const query = new URLSearchParams(location.search);

const state = {
  coin: query.get("coin") || "BTC",
  tf: ["15m", "1h", "4h"].includes(query.get("tf")) ? query.get("tf") : "1h",
  data: null,
  plan: null,
  coins: [],
};

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

function showPlan(plan) {
  state.plan = plan;
  drawScene(shownZones(state.data, plan), plan, state.data?.thin || []);
  renderPlan(el("lv-plan"), plan, sizeInputs());
}

async function load() {
  const node = el("lv-zones");
  node.innerHTML = `<div class="lv-empty">Loading…</div>`;
  try {
    const r = await fetch(`/api/levels?coin=${encodeURIComponent(state.coin)}&tf=${state.tf}`);
    // Причину отказа показываем на странице: в консоли её видит только автор.
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || `Request failed with status ${r.status}.`);
    }
    state.data = await r.json();
  } catch (err) {
    state.data = null;
    node.innerHTML = `<div class="lv-empty">${err.message}</div>`;
    el("lv-read").innerHTML = "";
    el("lv-context").innerHTML = "";
    el("lv-oi").innerHTML = "";
    el("lv-plan").innerHTML = `<div class="lv-empty">No data — nothing to plan.</div>`;
    el("lv-count").textContent = "";
    return;
  }

  const read = readPrice(state.data);
  renderRead(el("lv-read"), read);
  renderContext(el("lv-context"), state.data);
  renderOi(el("lv-oi"), state.data.coin, state.data.oi);
  await drawLevels(el("lv-chart"), state.data, (z) => showPlan(planFromZone(state.data, z)));
  // У зоны план открыт сразу; посередине между зонами выбирать нечего.
  showPlan(read.kind === "support" ? read.long : read.kind === "resistance" ? read.short : null);
  renderZones(node, state.data);
  el("lv-count").textContent = `${state.data.zones.length} zones`;
  el("lv-sources").textContent = SOURCE_NOTE;
  // Разбор записан сервером при этом запросе — журнал перечитывается после него.
  loadJournal();
}

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
  try {
    const r = await fetch("/api/levels/journal");
    if (!r.ok) throw new Error(`Request failed with status ${r.status}.`);
    const j = await r.json();
    renderJournalSummary(el("lv-journal-sum"), j);
    renderJournal(el("lv-journal"), j);
    el("lv-journal-count").textContent = `${j.open} waiting for outcome`;
  } catch (err) {
    el("lv-journal-sum").innerHTML = `<div class="lv-empty">${err.message}</div>`;
  }
}

el("lv-read").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-zone]");
  const z = state.data?.zones.find((x) => x.name === btn?.dataset.zone);
  if (!z) return;
  if (btn.dataset.kind === "break") {
    const read = readPrice(state.data);
    showPlan([read.breakUp, read.breakDown].find((p) => p?.stopZone === z) || null);
  } else showPlan(planFromZone(state.data, z));
});

for (const id of ["lv-equity", "lv-risk"]) {
  el(id).addEventListener("input", () => {
    saveSize({ equity: el("lv-equity").value, risk: el("lv-risk").value });
    renderPlan(el("lv-plan"), state.plan, sizeInputs());
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
paintIcons(el("sec-lv-chart"));

setInterval(refreshOi, OI_REFRESH_MS);

const saved = readSize();
el("lv-equity").value = saved.equity ?? "";
el("lv-risk").value = saved.risk ?? "1";
mountControls();
loadCoinUniverse().then((coins) => {
  state.coins = coins;
});
load();
initReveal();
