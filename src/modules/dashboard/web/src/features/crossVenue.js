// ─────────────────────────────────────────────────
//  Межбиржевое расхождение — живая витрина
// ─────────────────────────────────────────────────
// Единственная карточка на /lab, которая обновляется в реальном времени
// (раз в 2 секунды). Остальные показывают пересчитанное кроном, здесь же
// смысл именно в «прямо сейчас»: окна живут сотни миллисекунд, и увидеть их
// в суточной сводке нельзя — там останется только след.
//
// ── Две пары, и путать их нельзя ───────────────────────────────────────────
// HL ↔ Kraken — торговая. HL ↔ Binance — КОНТРОЛЬ: из Европы Binance
// недоступен, торговать там нечем. Контроль нужен, чтобы отличить «на Kraken
// реально другая цена» от «у Kraken тонкий стакан»: если расхождение с Kraken
// систематически больше, чем с Binance, это плата за неликвид, а не окно.
// Поэтому контрольная вкладка помечена явно и её итоги НЕ складываются с
// торговыми — иначе однажды прочитаются как деньги, которых взять нельзя.
//
// ── Правила отображения, каждое от конкретных граблей ──────────────────────
//  1. ВОЗРАСТ СНИМКА кричит первым. Карточка Spike-Fade три недели показывала
//     замёрзшие данные как живые, потому что возраст нигде не выводился.
//  2. Строка красится по ПОРОГУ, не по знаку. Расхождение в 5 бп — это ноль
//     возможностей при издержках 19 бп, и зелёный на нём был бы враньём.
//  3. Рядом с каждым «пробило» стоят ОБЪЁМ и время жизни. Замер 14.08: окна с
//     деньгами ($184, $87) жили 0-1 мс, а те, куда можно успеть, несли $5.
//  4. Спред каждой биржи показан отдельно: если расхождение целиком объясняется
//     широким спредом одной из площадок, это не окно, а цена входа в неликвид.

import { fetchJson } from "../net/api.js";

const fmtUsd = (v) => (Number.isFinite(v) ? `$${Math.round(v)}` : "—");
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}с` : `${Math.round(ms)}мс`);

/** Round-trip до бирж из Европы, замер 14.08.2026. Окно короче — недостижимо. */
const LATENCY_MS = 220;

/** Какая пара показана. Торговая по умолчанию — контроль надо выбрать осознанно. */
let activePair = "hl-kr";

export function bindCrossVenueTabs() {
  const box = document.getElementById("xv-tabs");
  if (!box) return;
  box.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-pair]");
    if (!btn) return;
    activePair = btn.dataset.pair;
    refreshCrossVenue();
  });
}

export async function refreshCrossVenue() {
  const tbody = document.getElementById("xv-tbody");
  if (!tbody) return;

  let d;
  try { d = await fetchJson("/api/xvenue"); } catch { return; }

  const meta = document.getElementById("xv-meta");
  const foot = document.getElementById("xv-foot");
  const tabs = document.getElementById("xv-tabs");

  if (!d?.ok || d.empty) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty-state">${d?.hint || "нет данных"}</td></tr>`;
    if (meta) { meta.textContent = "коллектор молчит"; meta.style.color = "var(--red)"; }
    return;
  }

  const pairs = d.pairs || [];
  const pair = pairs.find((p) => p.key === activePair) || pairs[0];
  if (!pair) return;

  if (tabs) {
    tabs.innerHTML = pairs.map((p) => `
      <button data-pair="${p.key}" style="
        font-size:11px; font-family:var(--font-mono); cursor:pointer;
        padding:2px 8px; margin-right:4px; border-radius:3px;
        border:1px solid ${p.key === pair.key ? "var(--accent, #888)" : "transparent"};
        background:${p.key === pair.key ? "var(--bg-hover, rgba(128,128,128,.15))" : "transparent"};
        color:${p.tradeable ? "var(--text)" : "var(--text-muted)"};
      " title="${p.tradeable ? "Здесь можно торговать" : "Опорная точка: из Европы Binance недоступен, торговать нечем"}">
        ${p.label} · ${p.costBp} бп
      </button>`).join("");
  }

  // Снимок пишется раз в 2с. 15 секунд молчания — это уже не «редко пишет».
  const dead = d.ageSec > 15;
  if (meta) {
    meta.textContent = dead
      ? `⚠ снимок протух ${d.ageSec}с назад — контейнер hl-xvenue встал`
      : `копит ${d.uptimeMin} мин · снимок ${d.ageSec}с назад`;
    meta.style.color = dead ? "var(--red)" : "var(--text-muted)";
  }

  const [aName, bName] = pair.key === "hl-kr" ? ["HL", "Kraken"] : ["HL", "Binance"];

  tbody.innerHTML = (pair.coins || []).map((c) => {
    if (!c.ready) {
      return `<tr style="opacity:.4"><td>${c.coin}</td><td colspan="6" class="empty-state">нет на одной из бирж</td></tr>`;
    }
    if (c.stale) {
      return `<tr style="opacity:.5">
        <td>${c.coin}</td>
        <td colspan="6" class="empty-state">соединение встало — не считаем</td>
      </tr>`;
    }

    const hit = c.netBp > 0;
    // Жёлтый — «близко, но мимо»: видно, что прибор жив и рынок дышит.
    const near = !hit && c.grossBp > pair.costBp * 0.6;
    const color = hit ? "var(--green)" : near ? "var(--yellow)" : "var(--text-muted)";
    const dirLabel = c.dir === "buyB" ? `куп. ${bName} → прод. ${aName}` : `куп. ${aName} → прод. ${bName}`;

    // Достижимо, только если окно живёт дольше дороги до биржи И несёт объём.
    const reach = hit && c.openMs >= LATENCY_MS && c.usd >= 50;
    // Контрольная пара не бывает «достижимой»: торговать там нечем.
    const verdict = !hit ? dirLabel
      : !pair.tradeable ? "только справка"
        : reach ? "достижимо" : "не успеть";
    const vColor = !hit ? "var(--text-muted)"
      : !pair.tradeable ? "var(--text-muted)"
        : reach ? "var(--green)" : "var(--red)";

    return `<tr>
      <td>${c.coin}</td>
      <td class="r" style="color:${color}">${c.grossBp.toFixed(2)}</td>
      <td class="r" style="color:${color}">${c.netBp > 0 ? "+" : ""}${c.netBp.toFixed(2)}</td>
      <td class="r" style="color:var(--text-muted)">${c.aSpreadBp.toFixed(1)} / ${c.bSpreadBp.toFixed(1)}</td>
      <td class="r" style="color:var(--text-muted)">${fmtUsd(c.usd)}</td>
      <td class="r" style="color:var(--text-muted)">${c.openMs ? fmtMs(c.openMs) : "—"}</td>
      <td style="color:${vColor}">
        ${verdict}
        ${!hit && c.quietMs > 3000
          ? `<span style="opacity:.5" title="Лучшая цена не менялась ${fmtMs(c.quietMs)}. Для неликвида это норма: в стакане отсутствие апдейта значит «цена та же». Монета в расчёт входит.">· тихо ${fmtMs(c.quietMs)}</span>`
          : ""}
      </td>
    </tr>`;
  }).join("");

  if (foot) {
    const day = (d.day || {})[pair.key] || {};
    const b = day.best;
    const feeNote = pair.key === "hl-kr"
      ? `Тейкер Kraken взят ${d.takers?.kr} бп — <b>проверь в кабинете</b>: на сетке Consumer он 25 бп, и тогда порог 59 бп.<br>`
      : "Торговать на Binance из Европы нельзя — вкладка нужна как опорная точка для Kraken.<br>";
    foot.innerHTML =
      feeNote +
      `За сутки окон выше порога: <b>${day.windows ?? 0}</b>, ` +
      `из них достижимых (жизнь ≥${LATENCY_MS} мс и объём ≥$50): <b>${day.reachable ?? 0}</b>` +
      (day.reachable ? ` на <b>$${(day.pnlUsd ?? 0).toFixed(2)}</b> потолка` : "") + ".<br>" +
      (b ? `Лучшее окно: ${b.coin} ${b.peakNetBp} бп чистыми, жило ${fmtMs(b.holdMs)}, объём ${fmtUsd(b.usd)}.<br>` : "") +
      `Апдейтов: HL ${(d.msg?.hl ?? 0).toLocaleString("ru")}, ` +
      `Kraken ${(d.msg?.kr ?? 0).toLocaleString("ru")}, ` +
      `Binance ${(d.msg?.bn ?? 0).toLocaleString("ru")}. ` +
      `Пропущено по несвежести: ${d.staleSkips ?? 0}.`;
  }
}
