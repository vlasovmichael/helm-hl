// ─────────────────────────────────────────────────
//  Межбиржевое расхождение HL ↔ Binance — живая витрина
// ─────────────────────────────────────────────────
// Единственная карточка на /lab, которая обновляется в реальном времени
// (раз в 2 секунды). Остальные показывают пересчитанное кроном, здесь же
// смысл именно в «прямо сейчас»: окна живут сотни миллисекунд, и увидеть их
// в суточной сводке нельзя — там останется только след.
//
// Три правила отображения, каждое от конкретных граблей:
//
//  1. ВОЗРАСТ СНИМКА кричит первым. Карточка Spike-Fade три недели показывала
//     замёрзшие данные как живые, потому что возраст нигде не выводился.
//     Здесь снимок старше 15 секунд = коллектор встал, и это красным.
//
//  2. Строка красится по ПОРОГУ, не по знаку. Расхождение в 5 бп — это ноль
//     возможностей при издержках 19 бп, и зелёный на нём был бы враньём.
//     Зелёное только то, что реально пробило четыре комиссии.
//
//  3. Рядом с каждым «пробило» стоит ОБЪЁМ и сколько окно уже живёт.
//     Замер 14.08: окна с деньгами ($184, $87) жили 0-1 мс, а те, куда можно
//     успеть, несли $5. Без этих двух колонок карточка показывает возможности,
//     которых нет.

import { fetchJson } from "../net/api.js";

const fmtUsd = (v) => (Number.isFinite(v) ? `$${Math.round(v)}` : "—");
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)}с` : `${Math.round(ms)}мс`);

/** Round-trip до бирж из Европы, замер 14.08.2026. Окно короче — недостижимо. */
const LATENCY_MS = 220;

export async function refreshCrossVenue() {
  const tbody = document.getElementById("xv-tbody");
  if (!tbody) return;

  let d;
  try { d = await fetchJson("/api/xvenue"); } catch { return; }

  const meta = document.getElementById("xv-meta");
  const foot = document.getElementById("xv-foot");

  if (!d?.ok || d.empty) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty-state">${d?.hint || "нет данных"}</td></tr>`;
    if (meta) { meta.textContent = "коллектор молчит"; meta.style.color = "var(--red)"; }
    return;
  }

  // Снимок пишется раз в 2с. 15 секунд молчания — это уже не «редко пишет».
  const dead = d.ageSec > 15;
  if (meta) {
    meta.textContent = dead
      ? `⚠ снимок протух ${d.ageSec}с назад — контейнер hl-xvenue встал`
      : `порог ${d.costBp} бп · копит ${d.uptimeMin} мин · снимок ${d.ageSec}с назад`;
    meta.style.color = dead ? "var(--red)" : "var(--text-muted)";
  }

  tbody.innerHTML = (d.coins || []).map((c) => {
    if (!c.ready) {
      return `<tr><td>${c.coin}</td><td colspan="5" class="empty-state">ждём обе биржи</td></tr>`;
    }
    if (c.stale) {
      // Встал СОКЕТ (а не монета затихла): расхождение в этот момент —
      // арифметика на протухшей цене. Какая именно биржа молчит, видно из
      // общего заголовка: тишина идёт сразу по всем монетам этой площадки.
      return `<tr style="opacity:.5">
        <td>${c.coin}</td>
        <td colspan="5" class="empty-state">соединение встало — не считаем</td>
      </tr>`;
    }

    const hit = c.netBp > 0;
    // Жёлтый — «близко, но мимо»: полезно видеть, что прибор жив и рынок дышит.
    const near = !hit && c.grossBp > d.costBp * 0.6;
    const color = hit ? "var(--green)" : near ? "var(--yellow)" : "var(--text-muted)";
    const dirLabel = c.dir === "buyBN" ? "куп. BN → прод. HL" : "куп. HL → прод. BN";

    // Окно засчитывается достижимым, только если живёт дольше дороги до биржи.
    const reach = hit && c.openMs >= LATENCY_MS && c.usd >= 50;

    return `<tr>
      <td>${c.coin}</td>
      <td class="r" style="color:${color}">${c.grossBp.toFixed(2)}</td>
      <td class="r" style="color:${color}">${c.netBp > 0 ? "+" : ""}${c.netBp.toFixed(2)}</td>
      <td class="r" style="color:var(--text-muted)">${fmtUsd(c.usd)}</td>
      <td class="r" style="color:var(--text-muted)">${c.openMs ? fmtMs(c.openMs) : "—"}</td>
      <td style="color:${hit ? (reach ? "var(--green)" : "var(--red)") : "var(--text-muted)"}">
        ${hit ? (reach ? "достижимо" : "не успеть") : dirLabel}
        ${!hit && c.quietMs > 3000
          ? `<span style="opacity:.5" title="По этой монете лучшая цена не менялась ${fmtMs(c.quietMs)}. Это нормально для неликвида: в стакане отсутствие апдейта значит «цена та же». В расчёт монета входит.">· тихо ${fmtMs(c.quietMs)}</span>`
          : ""}
      </td>
    </tr>`;
  }).join("");

  if (foot) {
    const day = d.day || {};
    const b = day.best;
    foot.innerHTML =
      `За сутки окон выше порога: <b>${day.windows ?? 0}</b>, ` +
      `из них достижимых (жизнь ≥${LATENCY_MS} мс и объём ≥$50): <b>${day.reachable ?? 0}</b>` +
      (day.reachable ? ` на <b>$${(day.pnlUsd ?? 0).toFixed(2)}</b> потолка` : "") + ".<br>" +
      (b ? `Лучшее окно: ${b.coin} ${b.peakNetBp} бп чистыми, жило ${fmtMs(b.holdMs)}, объём ${fmtUsd(b.usd)}.<br>` : "") +
      `Апдейтов: HL ${d.hlMsg?.toLocaleString("ru") ?? 0}, Binance ${d.bnMsg?.toLocaleString("ru") ?? 0}. ` +
      `Пропущено по несвежести фида: ${d.staleSkips ?? 0}.`;
  }
}
