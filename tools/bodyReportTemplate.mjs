/**
 * Вёрстка страницы «Тело». Данные вшиваются в HTML — страница самодостаточна,
 * наружу не ходит (в артефактах CSP всё равно режет любые внешние запросы).
 */

const esc = (s) => String(s).replace(/</g, '\\u003c');

export function renderPage(data) {
  return `<title>Тело — приборная панель</title>
<style>
  :root {
    color-scheme: light;
    --bg:      #f5f7f8;
    --panel:   #ffffff;
    --ink:     #12171b;
    --ink-2:   #59636d;
    --ink-3:   #8b949d;
    --rule:    #e1e7eb;
    --rule-2:  #eef2f4;
    --accent:  #2a78d6;
    --goal:    #eb6834;
    --shadow:  0 1px 2px rgba(18, 23, 27, .05), 0 8px 24px -16px rgba(18, 23, 27, .25);

    --mono: ui-monospace, "SF Mono", SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace;
    --sans: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      color-scheme: dark;
      --bg:     #0e1114;
      --panel:  #151a1e;
      --ink:    #ebeff2;
      --ink-2:  #9ba6af;
      --ink-3:  #68727b;
      --rule:   #232a30;
      --rule-2: #1b2126;
      --accent: #3987e5;
      --goal:   #d95926;
      --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px -16px rgba(0, 0, 0, .8);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --bg:     #0e1114;
    --panel:  #151a1e;
    --ink:    #ebeff2;
    --ink-2:  #9ba6af;
    --ink-3:  #68727b;
    --rule:   #232a30;
    --rule-2: #1b2126;
    --accent: #3987e5;
    --goal:   #d95926;
    --shadow: 0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px -16px rgba(0, 0, 0, .8);
  }

  * { box-sizing: border-box; }

  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 15px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
  }

  .sheet {
    max-width: 62rem;
    margin: 0 auto;
    padding: clamp(1.5rem, 4vw, 3.5rem) clamp(1rem, 4vw, 2.5rem) 5rem;
    display: flex;
    flex-direction: column;
    gap: 2.75rem;
  }

  /* --- микротипографика ---------------------------------------------------- */
  .label {
    font-family: var(--mono);
    font-size: .6875rem;
    font-weight: 500;
    letter-spacing: .11em;
    text-transform: uppercase;
    color: var(--ink-3);
  }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
  .prose { color: var(--ink-2); max-width: 62ch; }
  .prose strong { color: var(--ink); font-weight: 600; }

  /* --- шапка ---------------------------------------------------------------- */
  header { display: flex; flex-direction: column; gap: .75rem; }
  h1 {
    margin: 0;
    font-size: clamp(1.5rem, 4vw, 2rem);
    font-weight: 600;
    letter-spacing: -.02em;
    text-wrap: balance;
  }
  .readout {
    display: flex;
    flex-wrap: wrap;
    gap: .5rem 1.25rem;
    align-items: baseline;
    padding-top: .75rem;
    border-top: 1px solid var(--rule);
  }
  .readout span { font-family: var(--mono); font-size: .8125rem; color: var(--ink-3); }
  .readout b { color: var(--ink-2); font-weight: 500; }

  /* --- секции --------------------------------------------------------------- */
  section { display: flex; flex-direction: column; gap: 1.25rem; }
  .section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
  h2 { margin: 0; font-size: 1.0625rem; font-weight: 600; letter-spacing: -.01em; }

  .panel {
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 6px;
    box-shadow: var(--shadow);
  }

  /* --- крупная цифра -------------------------------------------------------- */
  .figure-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  }
  .figure {
    padding: 1.125rem 1.25rem;
    border-right: 1px solid var(--rule-2);
    display: flex;
    flex-direction: column;
    gap: .3rem;
  }
  .figure:last-child { border-right: 0; }
  .figure .v { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 1.75rem; font-weight: 500; letter-spacing: -.03em; line-height: 1.1; }
  .figure .v small { font-size: .875rem; font-weight: 400; color: var(--ink-3); margin-left: .15em; letter-spacing: 0; }
  .figure .sub { font-size: .8125rem; color: var(--ink-3); }

  .hero { padding: 1.75rem 1.5rem; display: flex; flex-wrap: wrap; gap: 2rem 3rem; align-items: flex-end; }
  .hero .v { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: clamp(3rem, 11vw, 4.5rem); font-weight: 500; letter-spacing: -.045em; line-height: .9; }
  .hero .v small { font-size: .3em; letter-spacing: 0; color: var(--ink-3); margin-left: .2em; }

  /* --- индикатор накопления ------------------------------------------------- */
  .ticks { display: flex; gap: 3px; margin-top: .5rem; }
  .ticks i { width: 7px; height: 18px; border-radius: 1.5px; background: var(--rule); }
  .ticks i.on { background: var(--accent); }

  /* --- чип состояния -------------------------------------------------------- */
  .chip {
    display: inline-flex; align-items: center; gap: .4rem;
    font-family: var(--mono); font-size: .6875rem; letter-spacing: .08em; text-transform: uppercase;
    padding: .25rem .5rem; border-radius: 3px;
    border: 1px solid var(--rule); color: var(--ink-2); background: var(--bg);
  }
  .chip::before { content: ""; width: 6px; height: 6px; border-radius: 1px; background: currentColor; }
  .chip.wait { color: var(--goal); border-color: color-mix(in srgb, var(--goal) 35%, var(--rule)); }
  .chip.live { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, var(--rule)); }

  /* --- график --------------------------------------------------------------- */
  .chart-wrap { padding: 1.25rem 1.25rem .75rem; overflow-x: auto; }
  svg { display: block; width: 100%; height: auto; }
  .bar { fill: var(--accent); opacity: .32; transition: opacity .12s ease; }
  .bar.hit { fill: var(--accent); opacity: .85; }
  .bar:hover, .bar.active { opacity: 1; }
  .gridline { stroke: var(--rule); stroke-width: 1; }
  .goalline { stroke: var(--goal); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .medline  { stroke: var(--ink-3); stroke-width: 1; stroke-dasharray: 2 3; }
  .axis { font-family: var(--mono); font-size: 10px; fill: var(--ink-3); }

  .legend { display: flex; flex-wrap: wrap; gap: .35rem 1.25rem; padding: 0 1.25rem 1.125rem; }
  .legend span { display: inline-flex; align-items: center; gap: .45rem; font-family: var(--mono); font-size: .75rem; color: var(--ink-3); }
  /* заливка и линия — разные формы, чтобы легенда читалась и без цвета */
  .swatch { width: 14px; height: 3px; border-radius: 1px; flex: none; }
  .swatch.fill { width: 10px; height: 12px; border-radius: 2px; }

  .tip {
    position: fixed; pointer-events: none; z-index: 10; opacity: 0;
    transform: translate(-50%, -100%) translateY(-10px);
    background: var(--panel); border: 1px solid var(--rule); border-radius: 5px;
    box-shadow: var(--shadow); padding: .5rem .625rem; min-width: 8.5rem;
    transition: opacity .1s ease;
  }
  .tip.show { opacity: 1; }
  .tip .d { font-family: var(--mono); font-size: .6875rem; color: var(--ink-3); letter-spacing: .04em; }
  .tip .n { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 1.125rem; font-weight: 500; }
  .tip table { border-collapse: collapse; margin-top: .4rem; width: 100%; }
  .tip td { font-family: var(--mono); font-size: .6875rem; color: var(--ink-3); padding: .05rem 0; }
  .tip td:last-child { text-align: right; font-variant-numeric: tabular-nums; color: var(--ink-2); }

  /* --- таблица источников --------------------------------------------------- */
  .tbl-wrap { overflow-x: auto; }
  table.data { border-collapse: collapse; width: 100%; font-size: .8125rem; }
  table.data th, table.data td { padding: .5rem .75rem; text-align: left; border-bottom: 1px solid var(--rule-2); white-space: nowrap; }
  table.data th { font-family: var(--mono); font-size: .6875rem; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; }
  table.data td.n { font-family: var(--mono); font-variant-numeric: tabular-nums; text-align: right; }
  table.data tr:last-child td { border-bottom: 0; }
  table.data tr.sum td { color: var(--goal); }
  table.data tr.pick td { color: var(--ink); font-weight: 600; }

  footer { border-top: 1px solid var(--rule); padding-top: 1.25rem; font-size: .8125rem; color: var(--ink-3); }
  code { font-family: var(--mono); font-size: .9em; background: var(--rule-2); padding: .1em .35em; border-radius: 3px; }

  a { color: var(--accent); }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 2px; }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
</style>

<div class="sheet">
  <header>
    <div class="label">Health Connect · Pixel 9 Pro</div>
    <h1>Тело</h1>
    <p class="prose">Два термометра и один рычаг. Термометры — вес и шаги — считаются сами. Рычаг — еда — не считается ничем и на этой странице его нет.</p>
    <div class="readout" id="readout"></div>
  </header>

  <section id="s-weight"></section>
  <section id="s-comp"></section>
  <section id="s-steps"></section>
  <section id="s-sources"></section>

  <footer>
    Страница пересобирается командой <code>node tools/bodyReport.mjs &lt;путь к экспорту&gt;</code>.
    Свежий <code>Health Connect.zip</code> лежит в Google&nbsp;Drive, папка <code>health</code> — экспорт перезаписывает один и тот же файл раз в сутки.
  </footer>
</div>

<div class="tip" id="tip" role="status" aria-live="polite"></div>

<script>
const DATA = ${esc(JSON.stringify(data))};

const nf = new Intl.NumberFormat('ru-RU');
const dfShort = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit' });
const dfLong = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const dfStamp = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const el = (id) => document.getElementById(id);
// ru-RU отдаёт «6 августа 2026 г.» — точка в конце склеивается с точкой предложения
const dateOf = (t) => dfLong.format(t).replace(/\\s*г\\.$/, '');
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
};

/* ── шапка: что за данные и насколько они свежие ────────────────────────── */
(() => {
  const ageH = (Date.now() - DATA.dataThrough) / 36e5;
  const fresh = ageH < 30;
  el('readout').innerHTML =
    '<span class="chip ' + (fresh ? 'live' : 'wait') + '">' +
      (fresh ? 'данные свежие' : 'экспорт отстаёт') + '</span>' +
    '<span>последняя запись <b>' + dfStamp.format(DATA.dataThrough) + '</b></span>' +
    '<span>источников <b>' + DATA.sources.length + '</b></span>';
})();

/* ── вес ─────────────────────────────────────────────────────────────────── */
(() => {
  const w = DATA.weight;
  const last = w[w.length - 1];
  const need = DATA.goals.WEIGHT_POINTS_NEEDED;
  const goal = DATA.goals.WEIGHT_GOAL;

  // «накоплено» считаем только по свежей серии — записи годовой давности тренд не образуют
  const cutoff = Date.now() - 60 * 864e5;
  const recent = w.filter((r) => r.t > cutoff);
  const prior = w.filter((r) => r.t <= cutoff).pop();
  const enough = recent.length >= need;

  const toGo = last ? (last.kg - goal).toFixed(1) : '—';

  el('s-weight').innerHTML =
    '<div class="section-head"><h2>Вес</h2>' +
      '<span class="chip ' + (enough ? 'live' : 'wait') + '">' +
        (enough ? 'тренд читается' : 'копим точки: ' + recent.length + ' из ' + need) + '</span>' +
    '</div>' +
    '<div class="panel">' +
      '<div class="hero">' +
        '<div>' +
          '<div class="label">сейчас</div>' +
          '<div class="v">' + (last ? last.kg.toFixed(1) : '—') + '<small>кг</small></div>' +
          '<div class="sub label" style="margin-top:.5rem">' +
            (last ? dateOf(last.t) + ' · ' + last.src : 'нет записей') + '</div>' +
        '</div>' +
        '<div>' +
          '<div class="label">до цели ' + goal + ' кг</div>' +
          '<div class="v" style="font-size:clamp(2rem,7vw,2.75rem)">−' + toGo + '<small>кг</small></div>' +
          '<div class="ticks" aria-hidden="true">' +
            Array.from({ length: need }, (_, i) =>
              '<i class="' + (i < recent.length ? 'on' : '') + '"></i>').join('') +
          '</div>' +
          '<div class="sub label" style="margin-top:.4rem">точек до первой оценки тренда</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<p class="prose">' +
      (enough
        ? 'Точек хватает — тренд можно считать.'
        : 'Одна точка — это не траектория, а засечка. График появится здесь сам, когда наберётся ' +
          need + ' ' + plural(need, 'замер', 'замера', 'замеров') + ': раньше дневной шум (±1 кг вода) перекрывает недельный сдвиг.') +
      (prior
        ? ' Предыдущая честная точка — <strong>' + prior.kg.toFixed(1) + ' кг</strong>, ' +
          dateOf(prior.t) + '. Между ней и сегодня измерений не было.'
        : '') +
    '</p>';
})();

/* ── состав тела ─────────────────────────────────────────────────────────── */
(() => {
  const c = DATA.composition;
  const cells = [
    { k: 'fatPct', label: 'жир', unit: '%', dp: 1 },
    { k: 'leanKg', label: 'сухая масса', unit: 'кг', dp: 1 },
    { k: 'waterKg', label: 'вода', unit: 'кг', dp: 1 },
    { k: 'boneKg', label: 'кость', unit: 'кг', dp: 1 },
    { k: 'bmrKcal', label: 'BMR', unit: 'ккал/сут', dp: 0 },
  ].filter((x) => c[x.k]);

  if (!cells.length) { el('s-comp').remove(); return; }

  const src = c[cells[0].k].src;
  const fat = c.fatPct ? (DATA.weight.at(-1).kg * c.fatPct.v / 100) : null;

  el('s-comp').innerHTML =
    '<div class="section-head"><h2>Состав</h2>' +
      '<span class="label">' + src + ' · один замер</span></div>' +
    '<div class="panel"><div class="figure-row">' +
      cells.map((x) =>
        '<div class="figure">' +
          '<div class="label">' + x.label + '</div>' +
          '<div class="v">' + c[x.k].v.toFixed(x.dp) + '<small>' + x.unit + '</small></div>' +
        '</div>').join('') +
    '</div></div>' +
    (fat
      ? '<p class="prose">Это <strong>' + fat.toFixed(1) + ' кг жира</strong>. Цель по весу — минус ' +
        (DATA.weight.at(-1).kg - DATA.goals.WEIGHT_GOAL).toFixed(1) +
        ' кг; если уходить будет не жир, а сухая масса, эти пять цифр покажут это раньше, чем весы.</p>'
      : '');
})();

/* ── шаги ────────────────────────────────────────────────────────────────── */
(() => {
  const rows = DATA.steps;
  const goal = DATA.goals.STEP_GOAL;
  const vals = rows.map((r) => r.steps);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const mean = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  const hits = vals.filter((v) => v >= goal).length;
  const DEAD = 3000; // ниже этого — день, когда никуда не выходил
  const dead = vals.filter((v) => v < DEAD).length;
  const ratio = goal / median;

  const W = 900, H = 240, PAD_L = 38, PAD_R = 8, PAD_T = 14, PAD_B = 22;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;
  const max = Math.max(goal, ...vals) * 1.08;
  const y = (v) => PAD_T + plotH - (v / max) * plotH;
  const bw = plotW / rows.length;
  const barW = Math.max(3, bw - 3); // 2px+ просвет между столбцами

  const ticks = [0, 5000, 10000, 15000, 20000].filter((t) => t <= max);

  const svg =
    '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Шаги по дням за ' + rows.length + ' дней">' +
      ticks.map((t) =>
        '<line class="gridline" x1="' + PAD_L + '" x2="' + (W - PAD_R) + '" y1="' + y(t) + '" y2="' + y(t) + '"/>' +
        '<text class="axis" x="' + (PAD_L - 6) + '" y="' + (y(t) + 3) + '" text-anchor="end">' +
          (t ? t / 1000 + 'к' : '0') + '</text>').join('') +
      rows.map((r, i) => {
        const h = Math.max(r.steps > 0 ? 2 : 0, plotH - (y(r.steps) - PAD_T));
        return '<rect class="bar' + (r.steps >= goal ? ' hit' : '') + '" data-i="' + i + '" ' +
          'x="' + (PAD_L + i * bw + (bw - barW) / 2).toFixed(2) + '" y="' + (PAD_T + plotH - h).toFixed(2) + '" ' +
          'width="' + barW.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="2"/>';
      }).join('') +
      '<line class="medline" x1="' + PAD_L + '" x2="' + (W - PAD_R) + '" y1="' + y(median) + '" y2="' + y(median) + '"/>' +
      '<line class="goalline" x1="' + PAD_L + '" x2="' + (W - PAD_R) + '" y1="' + y(goal) + '" y2="' + y(goal) + '"/>' +
      [0, Math.floor(rows.length / 2), rows.length - 1].map((i) =>
        '<text class="axis" x="' + (PAD_L + i * bw + bw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' +
          dfShort.format(new Date(rows[i].d)) + '</text>').join('') +
    '</svg>';

  el('s-steps').innerHTML =
    '<div class="section-head"><h2>Шаги</h2><span class="label">' + rows.length + ' дней</span></div>' +
    '<div class="panel">' +
      '<div class="figure-row">' +
        '<div class="figure"><div class="label">сегодня</div><div class="v">' + nf.format(vals.at(-1)) + '</div></div>' +
        '<div class="figure"><div class="label">медиана</div><div class="v">' + nf.format(median) + '</div></div>' +
        '<div class="figure"><div class="label">среднее</div><div class="v">' + nf.format(mean) + '</div></div>' +
        '<div class="figure"><div class="label">дней ≥ ' + nf.format(goal) + '</div>' +
          '<div class="v">' + hits + '<small>из ' + rows.length + '</small></div></div>' +
      '</div>' +
      '<div class="chart-wrap" id="chart">' + svg + '</div>' +
      '<div class="legend">' +
        '<span><i class="swatch fill" style="background:var(--accent);opacity:.32"></i>день</span>' +
        '<span><i class="swatch fill" style="background:var(--accent);opacity:.85"></i>цель взята</span>' +
        '<span><i class="swatch" style="background:var(--goal)"></i>цель ' + nf.format(goal) + '</span>' +
        '<span><i class="swatch" style="background:var(--ink-3)"></i>медиана ' + nf.format(median) + '</span>' +
      '</div>' +
    '</div>' +
    '<p class="prose">' +
      (ratio > 1.3
        ? 'Цель ' + nf.format(goal) + ' — это не «чуть добавить», а <strong>' + ratio.toFixed(1) +
          '× от медианы</strong>: считать её надо от ' + nf.format(median) + ', а не от нуля. '
        : 'Медиана ' + nf.format(median) + ' — цель ' + nf.format(goal) + ' стоит почти на ней (' +
          ratio.toFixed(2) + '×), то есть <strong>средний день её уже почти берёт</strong>. ' +
          'Разрыв не в среднем дне, а в разбросе: ') +
      '<strong>' + dead + ' ' + plural(dead, 'день', 'дня', 'дней') + ' из ' + rows.length +
      '</strong> ниже ' + nf.format(DEAD) + ' — это дни, когда никуда не выходил. ' +
      'Двигать нужно их, а не медиану.</p>';

  /* наведение: цель — не столбец, а вертикальная полоса шириной в день */
  const tip = el('tip');
  const wrap = el('chart');
  const bars = [...wrap.querySelectorAll('.bar')];
  let active = null;

  const show = (i, clientX) => {
    const r = rows[i];
    if (active !== null) bars[active].classList.remove('active');
    bars[i].classList.add('active');
    active = i;
    const box = bars[i].getBoundingClientRect();
    const rowsHtml = Object.entries(r.sources)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => '<tr><td>' + k + '</td><td>' + nf.format(v) + '</td></tr>').join('');
    tip.innerHTML =
      '<div class="d">' + dateOf(new Date(r.d)) + '</div>' +
      '<div class="n">' + nf.format(r.steps) + '</div>' +
      (rowsHtml ? '<table>' + rowsHtml + '</table>' : '');
    tip.style.left = (box.left + box.width / 2) + 'px';
    tip.style.top = box.top + 'px';
    tip.classList.add('show');
  };
  const hide = () => {
    if (active !== null) bars[active].classList.remove('active');
    active = null;
    tip.classList.remove('show');
  };

  wrap.addEventListener('pointermove', (e) => {
    const svgEl = wrap.querySelector('svg');
    const box = svgEl.getBoundingClientRect();
    const xInView = ((e.clientX - box.left) / box.width) * W;
    const i = Math.floor((xInView - PAD_L) / bw);
    if (i < 0 || i >= rows.length) return hide();
    if (i !== active) show(i);
  });
  wrap.addEventListener('pointerleave', hide);
  wrap.addEventListener('scroll', hide);
})();

/* ── источники: почему нельзя просто сложить ─────────────────────────────── */
(() => {
  const today = DATA.steps.at(-1);
  const entries = Object.entries(today.sources).sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) { el('s-sources').remove(); return; }

  const naive = entries.reduce((a, [, v]) => a + v, 0);

  el('s-sources').innerHTML =
    '<div class="section-head"><h2>Почему цифра одна, а источника три</h2></div>' +
    '<div class="panel tbl-wrap"><table class="data">' +
      '<thead><tr><th>источник</th><th style="text-align:right">шагов сегодня</th></tr></thead><tbody>' +
      entries.map(([k, v], i) =>
        '<tr' + (v === today.steps ? ' class="pick"' : '') + '><td>' + k +
        (v === today.steps ? ' ← берём' : '') + '</td><td class="n">' + nf.format(v) + '</td></tr>').join('') +
      '<tr class="sum"><td>наивная сумма</td><td class="n">' + nf.format(naive) + '</td></tr>' +
    '</tbody></table></div>' +
    '<p class="prose">Fitbit, Google Fit и системный счётчик пишут <strong>одни и те же шаги</strong>. ' +
      'Сложить их — получить ' + nf.format(naive) + ' вместо ' + nf.format(today.steps) + ', то есть втрое надутую цифру. ' +
      'Берём максимум по источникам за день: у каждого свои провалы, максимум латает дыры и не завышает.</p>';
})();
</script>
`;
}
