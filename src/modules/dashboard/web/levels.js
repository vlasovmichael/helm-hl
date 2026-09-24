import "./src/styles/index.scss";
// ─────────────────────────────────────────────────
// levels.html — механические уровни, два сценария у них и размер от риска.
// Страница не даёт сигналов: направление выбирает оператор, она считает
// геометрию сделки и то, как такая геометрия отыгрывала в окне.
// ─────────────────────────────────────────────────

import { bindTheme, startFooterTimer } from "./src/core/shell.js";
import { initReveal } from "./src/core/reveal.js";
import { mountPageHeader } from "./src/core/pageHeader.js";
import { mountTopnav } from "./src/core/topnav.js";
import { segmented } from "./src/core/ui.js";
import {
  coinCombo,
  attachCoinCombo,
  cleanTicker,
  loadCoinUniverse,
} from "./src/core/coinCombo.js";
import {
  drawLevels,
  drawZones,
  drawFib,
  drawScenarios,
  applyLevelsTheme,
} from "./src/charts/levelsChart.js";
import {
  buildScenarios,
  fibLevels,
  keyZones,
  renderScenarios,
  renderSizing,
} from "./src/features/levelScenarios.js";
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
  side: "short",
  entry: null,
  data: null,
  coins: [],
  scenarios: [],
  zones: "key",
  fib: true,
  scKey: "",
};

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
      state.entry = null;
      mountControls();
      load();
    }
  };

  el("lv-layers").innerHTML =
    segmented({
      name: "zones",
      value: state.zones,
      options: [
        { value: "key", label: "Key zones" },
        { value: "all", label: "All zones" },
      ],
    }) +
    segmented({
      name: "fib",
      value: state.fib ? "on" : "off",
      options: [
        { value: "on", label: "Fib" },
        { value: "off", label: "No fib" },
      ],
    });
  el("lv-layers").onclick = (e) => {
    const b = e.target.closest("[data-zones],[data-fib]");
    if (!b) return;
    if (b.dataset.zones) state.zones = b.dataset.zones;
    if (b.dataset.fib) state.fib = b.dataset.fib === "on";
    mountControls();
    drawLayers();
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

function drawLayers() {
  if (!state.data) return;
  const zones = state.zones === "all" ? state.data.zones : keyZones(state.data, state.scenarios);
  drawZones(state.data, zones);
  drawFib(state.fib ? fibLevels(state.data.candles) : null);
}

function sizeInputs() {
  const num = (id) => parseFloat(String(el(id).value).replace(",", "."));
  return { equity: num("lv-equity"), riskPct: num("lv-risk") };
}

function recalc() {
  if (!state.data) return;
  const entry = Number.isFinite(state.entry) ? state.entry : state.data.price;
  const plan = buildPlan(state.data, { side: state.side, entry });
  const live = plan && !plan.incomplete ? plan : null;
  renderPlan(el("lv-plan"), plan, state.side);
  // Коробка на графике — только у плана, прошедшего порог: картинка не спорит с вердиктом.
  drawScenarios(state.scenarios, live?.ok ? live : null);
  // Карточки перерисовываются только на смену плана: иначе шкалы заново
  // заполняются на каждый символ в поле депо.
  const scKey = `${state.coin}:${state.tf}:${live ? `${live.side}:${live.entry}` : ""}:${state.data.price}`;
  if (scKey !== state.scKey) {
    state.scKey = scKey;
    renderScenarios(el("lv-scenarios"), state.scenarios, live ? `${live.side}:${live.entry}` : "", state.data);
  }
  renderSizing(el("lv-size"), live, sizeInputs());
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

  state.scenarios = buildScenarios(state.data);
  pickDefaultScenario();
  await drawLevels(el("lv-chart"), state.data, keyZones(state.data, state.scenarios));
  drawLayers();
  renderZones(node, state.data);
  el("lv-count").textContent = `${state.data.zones.length} zones`;
  el("lv-sources").textContent = SOURCE_NOTE;
  el("lv-price").value = String(Number.isFinite(state.entry) ? state.entry : state.data.price);
  recalc();
}

/** По умолчанию открыт сценарий выбранной стороны, а если его нет — любой годный. */
function pickDefaultScenario() {
  const usable = state.scenarios.filter((s) => !s.noTrade && s.plan && !s.plan.incomplete);
  const pick = usable.find((s) => s.side === state.side) || usable[0];
  if (pick) applyScenario(pick);
}

function applyScenario(s) {
  state.side = s.side;
  state.entry = s.plan.entry;
  el("lv-price").value = String(s.plan.entry);
  mountControls();
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

el("lv-scenarios").addEventListener("click", (e) => {
  const id = e.target.closest("[data-sc]")?.dataset.sc;
  const s = state.scenarios.find((x) => x.id === id);
  if (!s) return;
  applyScenario(s);
  recalc();
});

for (const id of ["lv-equity", "lv-risk"]) {
  el(id).addEventListener("input", () => {
    saveSize({ equity: el("lv-equity").value, risk: el("lv-risk").value });
    recalc();
  });
}

el("lv-market").addEventListener("click", () => {
  if (!state.data) return;
  state.entry = null;
  el("lv-price").value = String(state.data.price);
  recalc();
});

const saved = readSize();
el("lv-equity").value = saved.equity ?? "";
el("lv-risk").value = saved.risk ?? "1";
mountControls();
loadCoinUniverse().then((coins) => {
  state.coins = coins;
});
load();
initReveal();
