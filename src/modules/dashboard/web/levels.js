import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
// levels.html — механические уровни и плечо риска перед входом.
// 🚨 Страница не даёт сигналов: ни один источник уровней не проверен форвардом.
// Её вывод — только геометрия сделки: стоп, цель и отношение одного к другому.
// ─────────────────────────────────────────────────

import { bindTheme, startFooterTimer } from "./src/core/shell.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
import { mountTopnav } from "./src/core/topnav.js";
import { segmented } from "./src/core/ui.js";
import {
  coinCombo,
  attachCoinCombo,
  cleanTicker,
  loadCoinUniverse,
} from "./src/core/coinCombo.js";
import { drawLevels, drawPlan, applyLevelsTheme } from "./src/charts/levelsChart.js";
import {
  buildPlan,
  renderPlan,
  renderZones,
  renderSuggestions,
  greenEntries,
  SOURCE_NOTE,
} from "./src/features/levelPlan.js";

mountTopnav("levels");
mountPageHeader({
  eyebrow: "Research · mechanical levels",
  title: "Levels",
  note: "Rule-drawn zones. They size the risk; they do not predict direction.",
});
bindTheme([applyLevelsTheme]);
startFooterTimer();

const state = { coin: "BTC", tf: "1h", side: "short", entry: null, data: null, coins: [] };

const el = (id) => document.getElementById(id);

function mountControls() {
  el("lv-coin").innerHTML = coinCombo({ id: "lv-coin-input", value: state.coin });
  attachCoinCombo(el("lv-coin-input"), {
    getCoins: () => state.coins,
    onPick: (c) => {
      state.coin = cleanTicker(c);
      state.entry = null;
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

  el("lv-side").innerHTML = segmented({
    name: "side",
    value: state.side,
    options: [
      { value: "long", label: "Long" },
      { value: "short", label: "Short" },
    ],
  });
  el("lv-side").onclick = (e) => {
    const side = e.target.closest("[data-side]")?.dataset.side;
    if (side && side !== state.side) {
      state.side = side;
      mountControls();
      recalc();
    }
  };
}

function recalc() {
  if (!state.data) return;
  const entry = Number.isFinite(state.entry) ? state.entry : state.data.price;
  const plan = buildPlan(state.data, { side: state.side, entry });
  renderPlan(el("lv-plan"), plan, state.side);
  drawPlan(plan && !plan.incomplete ? plan : null);
  renderSuggestions(el("lv-suggest"), state.data, state.side);
  const found = greenEntries(state.data, state.side).length;
  el("lv-suggest-count").textContent = found ? `${found} found` : "none";
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
    el("lv-plan").innerHTML = `<div class="lv-empty">No data — nothing to plan.</div>`;
    el("lv-count").textContent = "";
    return;
  }

  await drawLevels(el("lv-chart"), state.data);
  renderZones(node, state.data);
  el("lv-count").textContent = `${state.data.zones.length} zones`;
  el("lv-sources").textContent = SOURCE_NOTE;
  if (!Number.isFinite(state.entry)) el("lv-price").value = String(state.data.price);
  recalc();
}

el("lv-price").addEventListener("input", (e) => {
  const v = parseFloat(String(e.target.value).replace(",", "."));
  state.entry = Number.isFinite(v) && v > 0 ? v : null;
  recalc();
});

// Кнопка у готового входа только подставляет цену: решение остаётся за полем.
el("lv-suggest").addEventListener("click", (e) => {
  const raw = e.target.closest("[data-entry]")?.dataset.entry;
  const v = parseFloat(raw ?? "");
  if (!Number.isFinite(v) || v <= 0) return;
  state.entry = v;
  el("lv-price").value = String(v);
  recalc();
});

el("lv-market").addEventListener("click", () => {
  if (!state.data) return;
  state.entry = null;
  el("lv-price").value = String(state.data.price);
  recalc();
});

mountControls();
loadCoinUniverse().then((coins) => {
  state.coins = coins;
});
load();
