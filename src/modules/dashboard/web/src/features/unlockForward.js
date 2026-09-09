// ─────────────────────────────────────────────────
//  Unlock forward — витрина форварда `unlock-cliff-front-2026-09`.
//  Считает и копит бэкенд (tools/unlocksForward.mjs), здесь только показ.
//
//  🚨 Витрина намеренно не выводит вердикт: стоп-правило гипотезы разрешает
//  оценку ровно один раз, при n=60. Промежуточная медиана показывается, но
//  подписана как «не вердикт» — иначе форвард превратится в подглядывание,
//  а оно ломает p-value независимо от того, как честно посчитан тест.
// ─────────────────────────────────────────────────

const d10 = (ts) => new Date(ts).toISOString().slice(0, 10);
const fmtUsd = (v) =>
  v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : `$${Math.round(v / 1e3)}K`;

function statusBlock(r) {
  const pct = Math.min(100, (r.closed / r.evaluateAt) * 100);
  return `
    <div class="unlock-status">
      <div class="unlock-n">
        <span class="mono unlock-n-val">${r.closed}</span>
        <span class="unlock-n-of">/ ${r.evaluateAt}</span>
        <div class="label">settled trades</div>
      </div>
      <div class="unlock-progress">
        <div class="unlock-bar"><i style="width:${pct.toFixed(0)}%"></i></div>
        <div class="unlock-meta">
          <b>${r.pending}</b> queued
          · <b>${r.skippedLookahead}</b> discarded — found after their own entry date,
          entering them would be hindsight
        </div>
      </div>
    </div>`;
}

function upcomingTable(rows) {
  if (!rows.length) return `<div class="unlock-empty">No unlocks above the threshold in the window.</div>`;
  const today = new Date().toISOString().slice(0, 10);
  return `
    <table class="table table--compact">
      <thead><tr>
        <th>Coin</th><th class="num">Enter</th><th class="num">Unlock</th>
        <th class="num col-opt">Size</th><th class="num">× daily vol</th><th class="col-opt">Category</th>
      </tr></thead>
      <tbody>${rows
        .map((u) => {
          const isToday = d10(u.entryTs) === today;
          return `<tr${isToday ? ' class="unlock-today"' : ""}>
            <td class="strong">${u.coin}</td>
            <td class="num mono">${d10(u.entryTs)}${isToday ? ' <span class="chip">today</span>' : ""}</td>
            <td class="num mono muted">${d10(u.unlockTs)}</td>
            <td class="num mono col-opt">${fmtUsd(u.usd)}</td>
            <td class="num mono"><span class="chip${u.ratio >= 10 ? " chip--hot" : ""}">${u.ratio.toFixed(1)}×</span></td>
            <td class="muted col-opt">${u.category}</td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
}

function settledBlock(r) {
  if (!r.trades.length) {
    const first = r.upcoming.length ? d10(r.upcoming[0].unlockTs) : "—";
    return `<div class="unlock-empty">Nothing settled yet. First unlock in this batch resolves on <b>${first}</b>.</div>`;
  }
  return `
    <div class="table-wrap"><table class="table table--compact">
      <thead><tr><th>Coin</th><th class="num">Entry</th><th class="num">Unlock</th><th class="num">Net, bp</th></tr></thead>
      <tbody>${r.trades
        .map(
          (t) => `<tr>
            <td class="strong">${t.coin}</td>
            <td class="num mono">${d10(t.entryTs)}</td>
            <td class="num mono muted">${d10(t.unlockTs)}</td>
            <td class="num mono ${t.netBp > 0 ? "up" : "down"}">${t.netBp > 0 ? "+" : ""}${t.netBp.toFixed(0)}</td>
          </tr>`,
        )
        .join("")}</tbody>
    </table></div>
    <div class="unlock-note">
      Median ${r.medianNetBp?.toFixed(0)} bp · win share ${r.winShare?.toFixed(0)}% · ${r.coins} coins.
      <b>This is not a verdict.</b> The pre-registration allows exactly one evaluation, at n = ${r.evaluateAt}.
    </div>`;
}

export function renderUnlockForward(r) {
  if (!r) return;
  const set = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };
  set("unlock-status", statusBlock(r));
  set("unlock-upcoming", upcomingTable(r.upcoming || []));
  set("unlock-settled", settledBlock(r));
  const lock = document.getElementById("unlock-lock");
  if (lock) {
    lock.innerHTML = r.verdictAllowed
      ? `<span class="chip chip--ready">n reached — evaluate once</span>`
      : `<span class="chip chip--lock">verdict locked until n = ${r.evaluateAt}</span>`;
  }
  const cnt = document.getElementById("unlock-count");
  if (cnt) cnt.textContent = `${(r.upcoming || []).length} shown`;
}
