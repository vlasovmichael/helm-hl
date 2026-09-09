// ─────────────────────────────────────────────────
//  Калибратор — витрина цены входа в монету.
//
//  🚨 Страница намеренно не подсказывает сторону: направления в ценовом ряду
//  нет, и витрина, делающая вид, что оно есть, дороже отсутствующей.
//  Здесь только «сколько стоит попытка» — разрыв между тем, что даёт рынок
//  сам, и тем, что нужно для нуля.
// ─────────────────────────────────────────────────

let DATA = null;
let cur = null;
let MODE = "T";   // T — вход по рынку, M — вход лимиткой

const need = (g) => (MODE === "T" ? g.needT : g.needM);
const gap = (g) => (MODE === "T" ? g.gapT : g.gapM);
const expect = (g) => (MODE === "T" ? g.eT : g.eM);
const cost = (c) => (MODE === "T" ? c.costTaker : c.costMaker);
const share = (c) => (MODE === "T" ? c.shareTaker : c.shareMaker);
const best = (c) => c.grid.reduce((a, b) => (gap(b) < gap(a) ? b : a));

const fmtUsd = (v) =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${Math.round(v / 1e6)}M` : `$${Math.round(v / 1e3)}K`;

// Разрыв красим по величине: до 5 п.п. — досягаемо, свыше 10 — вряд ли.
const gapTone = (g) => (g <= 5 ? "calib-up" : g <= 10 ? "calib-warn" : "calib-down");

// Клетка серая, если ноль внутри доверительного интервала: там нечего сказать,
// и цвет создавал бы видимость знания.
function cellTone(g) {
  const sure = Math.abs(expect(g)) > g.ci;
  if (!sure) return { bg: "var(--canvas-subtle)", fg: "var(--text-faint)" };
  const k = Math.min(Math.abs(expect(g)) / 12, 1);
  return expect(g) > 0
    ? { bg: `rgba(46,160,67,${(0.1 + k * 0.35).toFixed(2)})`, fg: "var(--green)" }
    : { bg: `rgba(248,81,73,${(0.07 + k * 0.28).toFixed(2)})`, fg: "var(--red)" };
}

function rankTable() {
  const names = Object.keys(DATA.coins).sort((a, b) => gap(best(DATA.coins[a])) - gap(best(DATA.coins[b])));
  const maxGap = Math.max(...names.map((n) => gap(best(DATA.coins[n]))));
  return `
    <table class="table table--compact">
      <thead><tr>
        <th>Coin</th><th class="num">Hourly range</th><th class="num col-opt">Round trip</th>
        <th class="num col-opt">Cost / range</th><th class="num col-opt">Best pair</th>
        <th class="num">Market gives</th><th class="num">Needs</th><th class="num">Gap</th>
      </tr></thead>
      <tbody>${names
        .map((n) => {
          const c = DATA.coins[n], g = best(c), gp = gap(g);
          return `<tr data-coin="${n}"${n === cur ? ' class="is-selected"' : ""}>
            <td class="strong">${n}</td>
            <td class="num mono">${c.atr} <span class="muted">bp</span></td>
            <td class="num mono col-opt">${cost(c)} <span class="muted">bp</span></td>
            <td class="num mono col-opt">${share(c)}<span class="muted">%</span></td>
            <td class="num mono muted col-opt">${g.mt}× / ${g.ms}×</td>
            <td class="num mono">${g.hit}<span class="muted">%</span></td>
            <td class="num mono">${need(g)}<span class="muted">%</span></td>
            <td class="num mono ${gapTone(gp)}">
              <span class="calib-gap">
                <span class="calib-gapbar"><i style="width:${((gp / maxGap) * 100).toFixed(0)}%"></i></span>
                <span class="calib-gapval">+${gp}<span class="muted"> pp</span></span>
              </span>
            </td>
          </tr>`;
        })
        .join("")}</tbody>
    </table>`;
}

function gridTable(c) {
  const M = DATA.mult;
  return `
    <div class="calib-gridwrap"><table class="calib-heat">
      <thead>
        <tr><th></th><th colspan="${M.length}" class="calib-axis">Stop, × range</th></tr>
        <tr><th class="calib-axis calib-axis--y">Target</th>${M.map((m) => `<th>${m}×</th>`).join("")}</tr>
      </thead>
      <tbody>${M.map(
        (mt) => `<tr><th>${mt}×</th>${M.map((ms) => {
          const g = c.grid.find((x) => x.mt === mt && x.ms === ms);
          const t = cellTone(g);
          return `<td><button class="calib-cell" type="button" data-k="${mt}_${ms}" style="background:${t.bg}">
            <span class="calib-e" style="color:${t.fg}">${expect(g) > 0 ? "+" : ""}${expect(g)}</span>
            <span class="calib-p" style="color:${t.fg}">${g.hit}%</span>
          </button></td>`;
        }).join("")}</tr>`,
      ).join("")}</tbody>
    </table></div>`;
}

function detail(c, g) {
  const usd = (v) => (v / 1e4) * c.px;
  const sure = Math.abs(expect(g)) > g.ci;
  const gp = gap(g);
  return `
    <div class="calib-detail">
      <div><div class="label">Target</div><div class="value mono">${g.tgt} <small>bp · $${usd(g.tgt).toPrecision(3)}</small></div></div>
      <div><div class="label">Stop</div><div class="value mono">${g.stp} <small>bp · $${usd(g.stp).toPrecision(3)}</small></div></div>
      <div><div class="label">Market reaches target</div><div class="value mono calib-up">${g.hit}<small>%</small></div></div>
      <div><div class="label">Break-even needs</div><div class="value mono calib-warn">${need(g)}<small>%</small></div></div>
      <div class="calib-hero ${gapTone(gp)}">
        <div class="label">Gap to close</div>
        <div class="value mono">+${gp} <small>pp</small></div>
      </div>
      <div><div class="label">Expectancy</div><div class="value mono ${sure ? (expect(g) > 0 ? "calib-up" : "calib-down") : "muted"}">${expect(g) > 0 ? "+" : ""}${expect(g)} <small>± ${g.ci} bp</small></div></div>
      <div class="calib-note">
        Out of 100 trades with this pair the market itself reaches the target <b>${g.hit}</b> times.
        Covering the <b>${cost(c)} bp</b> round trip needs <b>${need(g)}</b>.
        The <b>${gp} pp</b> difference is what your read of the market has to supply.
        ${sure ? "" : "Expectancy here is indistinguishable from zero: the interval is wider than the number."}
      </div>
    </div>`;
}

function selectCell(g) {
  const c = DATA.coins[cur];
  document.querySelectorAll(".calib-cell").forEach((el) =>
    el.classList.toggle("is-selected", el.dataset.k === `${g.mt}_${g.ms}`),
  );
  const host = document.getElementById("calib-detail");
  if (host) host.innerHTML = detail(c, g);
}

function selectCoin(name, { scroll = false } = {}) {
  cur = name;
  const c = DATA.coins[name];
  if (!c) return;
  document.querySelectorAll("#calib-rank tr[data-coin]").forEach((tr) =>
    tr.classList.toggle("is-selected", tr.dataset.coin === name),
  );
  const title = document.getElementById("calib-coin");
  if (title) title.textContent = name;
  const meta = document.getElementById("calib-atr");
  if (meta) meta.innerHTML = `<span class="chip">${c.atr} bp / hour</span><span class="chip">${fmtUsd(c.vlm)} / day</span>`;
  const host = document.getElementById("calib-grid");
  if (host) {
    host.innerHTML = gridTable(c);
    // Класс снимается по окончании — иначе повторный выбор той же монеты
    // не проигрывает вход заново.
    host.classList.remove("is-entering");
    void host.offsetWidth;
    host.classList.add("is-entering");
    setTimeout(() => host.classList.remove("is-entering"), 700);
  }
  document.querySelectorAll(".calib-cell").forEach((el) =>
    el.addEventListener("click", () => {
      const [mt, ms] = el.dataset.k.split("_").map(Number);
      selectCell(c.grid.find((x) => x.mt === mt && x.ms === ms));
    }),
  );
  selectCell(best(c));

  // Подводим к сетке только по клику: на первой отрисовке страница и так
  // стоит наверху, и прыжок вниз выглядел бы как чужое действие.
  // 🚨 behavior не задаём — плавность берётся из scroll-behavior на html,
  // а он сам выключается при prefers-reduced-motion.
  if (scroll) {
    const section = document.getElementById("sec-calib-grid");
    if (section) section.scrollIntoView({ block: "start" });
  }
}

function paint() {
  const rank = document.getElementById("calib-rank");
  if (rank) {
    rank.innerHTML = rankTable();
    rank.querySelectorAll("tr[data-coin]").forEach((tr) =>
      tr.addEventListener("click", () => selectCoin(tr.dataset.coin, { scroll: true })),
    );
  }
  const names = Object.keys(DATA.coins);
  selectCoin(cur && DATA.coins[cur] ? cur : names.sort((a, b) => DATA.coins[b].vlm - DATA.coins[a].vlm)[0]);
}

export function bindCalibratorMode() {
  document.querySelectorAll("#calib-mode .seg__btn").forEach((b) =>
    b.addEventListener("click", () => {
      MODE = b.dataset.mode;
      document.querySelectorAll("#calib-mode .seg__btn").forEach((x) => x.classList.toggle("active", x === b));
      if (DATA) paint();
    }),
  );
}

export function renderCalibrator(payload) {
  if (!payload?.coins) return;
  DATA = payload;
  paint();
}
