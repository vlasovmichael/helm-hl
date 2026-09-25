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
import { coinCombo, attachCoinCombo, cleanTicker, loadCoinUniverse } from "./src/core/coinCombo.js";
import { drawLevels, drawScene, applyLevelsTheme } from "./src/charts/levelsChart.js";
import {
  readPrice,
  planFromZone,
  shownZones,
  renderRead,
  renderPlan,
  renderZones,
  SOURCE_NOTE,
} from "./src/features/levelPlan.js";

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
  drawScene(shownZones(state.data, plan), plan);
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
    el("lv-plan").innerHTML = `<div class="lv-empty">No data — nothing to plan.</div>`;
    el("lv-count").textContent = "";
    return;
  }

  const read = readPrice(state.data);
  renderRead(el("lv-read"), read);
  await drawLevels(el("lv-chart"), state.data, (z) => showPlan(planFromZone(state.data, z)));
  // У зоны план открыт сразу; посередине между зонами выбирать нечего.
  showPlan(read.kind === "support" ? read.long : read.kind === "resistance" ? read.short : null);
  renderZones(node, state.data);
  el("lv-count").textContent = `${state.data.zones.length} zones`;
  el("lv-sources").textContent = SOURCE_NOTE;
}

el("lv-read").addEventListener("click", (e) => {
  const name = e.target.closest("[data-zone]")?.dataset.zone;
  const z = state.data?.zones.find((x) => x.name === name);
  if (z) showPlan(planFromZone(state.data, z));
});

for (const id of ["lv-equity", "lv-risk"]) {
  el(id).addEventListener("input", () => {
    saveSize({ equity: el("lv-equity").value, risk: el("lv-risk").value });
    renderPlan(el("lv-plan"), state.plan, sizeInputs());
  });
}

const saved = readSize();
el("lv-equity").value = saved.equity ?? "";
el("lv-risk").value = saved.risk ?? "1";
mountControls();
loadCoinUniverse().then((coins) => {
  state.coins = coins;
});
load();
initReveal();
