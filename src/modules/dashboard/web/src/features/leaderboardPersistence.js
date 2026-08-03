// ─────────────────────────────────────────────────
//  Копировать некого? — витрина теста персистентности на лидерборде HL.
//  Тянет /api/leaderboard-persistence (снимки — tools/leaderboardSnapshot.mjs,
//  счёт — tools/leaderboardStats.mjs).
//
//  Показывает out-of-sample картину: ранг по прошлому окну → эдж в следующем.
//  Рядом ОБЯЗАТЕЛЬНО полоса шума (перестановочный бейзлайн) и CI: на n≈13k
//  любой градиент выглядит убедительно, и без бейзлайна таблица врёт.
//  2026-08-03.
// ─────────────────────────────────────────────────

import { fetchJson } from "../net/api.js";

const col = (v) =>
  v == null || !Number.isFinite(v) || v === 0
    ? ""
    : `color:${v > 0 ? "var(--green)" : "var(--red)"}`;

const bp = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "—");

const usd = (v) => {
  if (!Number.isFinite(v)) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${Math.round(v / 1e3)}k`;
  return `$${Math.round(v)}`;
};

function renderTable(tbody, res) {
  tbody.innerHTML = res.deciles
    .map((d) => {
      const isEdge = d.decile === 1 || d.decile === 10;
      return `<tr${isEdge ? ' style="font-weight:600"' : ""}>
        <td>D${d.decile}${d.decile === 1 ? " <span style='color:var(--text-muted);font-weight:400'>худшие</span>" : ""}${
          d.decile === 10 ? " <span style='color:var(--text-muted);font-weight:400'>лучшие</span>" : ""
        }</td>
        <td class="r">${d.n}</td>
        <td class="r" style="${col(d.medianEdgeBp)}">${bp(d.medianEdgeBp)}</td>
        <td class="r">${(d.shareProfitable * 100).toFixed(0)}%</td>
        <td class="r">${usd(d.medianAccountUsd)}</td>
      </tr>`;
    })
    .join("");
}

// Вердикт — главное, ради чего таблица существует. Формулировка держится за
// факт «есть ли когорта с положительной медианой», а не за красоту градиента.
function verdictHtml(res) {
  if (!res.anyPositiveCohort) {
    return `<span style="color:var(--red);font-weight:600">Копировать некого.</span>
      Ни один дециль не имеет положительного медианного эджа — включая бывших чемпионов
      (D10: ${bp(res.topDecile.medianEdgeBp)} бп, 95% CI [${bp(res.topDecile.ciLoBp)}; ${bp(res.topDecile.ciHiBp)}],
      прибыльны ${(res.topDecile.shareProfitable * 100).toFixed(0)}%).`;
  }
  return `<span style="color:var(--green);font-weight:600">Есть когорта с положительной медианой.</span>
    D10: ${bp(res.topDecile.medianEdgeBp)} бп, 95% CI [${bp(res.topDecile.ciLoBp)}; ${bp(res.topDecile.ciHiBp)}].
    Прежде чем что-то строить — проверить, переживает ли это вычет своих комиссий.`;
}

function statsHtml(res, snapshotCount) {
  const s = res.spread;
  // Спред вне полосы шума = связь прошлого с будущим реальна. Но направление
  // связи таблица показывает отдельно: «лузеры продолжают» — тоже персистентность.
  const signif = Math.abs(s.observedBp) > Math.max(Math.abs(s.noiseLoBp), Math.abs(s.noiseHiBp));
  return [
    `Ранг: ${res.rankWindow} → проверка: ${res.testWindow}`,
    `Универсум ${res.universe.toLocaleString("ru")} адресов (оборот &gt;$${res.minVlmUsd.toLocaleString("ru")} в оба окна, порог механический — не по результату). Исключено ${res.excludedFlat} с PnL ровно 0 (открыты, не закрыты).`,
    `Спред D10−D1: <b>${bp(s.observedBp)} бп</b> · полоса шума [${bp(s.noiseLoBp)}; ${bp(s.noiseHiBp)}] по ${s.permIters} перестановкам · p=${s.pValue < 1 / s.permIters ? `&lt;${(1 / s.permIters).toFixed(3)}` : s.pValue.toFixed(3)} → ${
      signif ? "связь прошлого с будущим реальна" : "от шума не отличается"
    }`,
    res.mode === "reconstructed"
      ? `⚠️ Режим reconstructed: окно теста — один месяц, один режим рынка. Снимков накоплено ${snapshotCount}; форвардный тест включится, когда архив дорастёт.`
      : `Режим forward: ранжирование зафиксировано нашим снимком, проверка на приросте (${res.spanDays} дн., ${res.matched?.toLocaleString("ru")} адресов сматчено).`,
    `⚠️ Выживальщики: слившие и переставшие торговать выпадают из универсума — реальная картина хуже нарисованной.`,
  ]
    .map((x) => `<div>${x}</div>`)
    .join("");
}

export async function refreshLeaderboardPersistence() {
  const tbody = document.getElementById("lbp-tbody");
  const meta = document.getElementById("lbp-meta");
  const verdict = document.getElementById("lbp-verdict");
  const stats = document.getElementById("lbp-stats");
  if (!tbody) return;

  const fail = (msg) => {
    if (meta) meta.textContent = msg;
    if (verdict) verdict.textContent = msg;
    tbody.innerHTML = `<tr><td colspan="5" class="empty-state">${msg}</td></tr>`;
    if (stats) stats.innerHTML = "";
  };

  let d;
  try {
    d = await fetchJson("/api/leaderboard-persistence");
  } catch {
    fail("нет связи");
    return;
  }

  if (!d || d.ok === false) {
    fail(d?.reason === "no-snapshots" ? "снимков ещё нет — первый по понедельникам 05:00" : "нет данных");
    return;
  }

  // Форвард честнее reconstructed — показываем его, как только он созрел.
  const res = d.forward?.ok ? d.forward : d.reconstructed;
  if (!res?.ok) {
    fail("данных не хватает для теста");
    return;
  }

  if (meta) {
    meta.textContent = `${res.mode} · снимков: ${d.snapshotCount} · ${new Date(res.capturedAt)
      .toISOString()
      .slice(0, 10)}`;
  }
  if (verdict) {
    verdict.classList.remove("empty-state");
    verdict.innerHTML = verdictHtml(res);
  }
  renderTable(tbody, res);
  if (stats) stats.innerHTML = statsHtml(res, d.snapshotCount);
}
