// ─────────────────────────────────────────────────────────────────────────────
//  Claim-Check — арифметика чужих обещаний.
//
//  ЗАЧЕМ: промо-посты («1420 сделок, 98.4% winrate, +$38k за 4 часа, просадка
//  <0.4%») обычно нельзя опровергнуть напрямую — данных нет. Зато можно спросить,
//  ЧТО ДОЛЖНО БЫТЬ ПРАВДОЙ, чтобы эти числа сошлись между собой: какой оборот,
//  какая комиссия, какого размера убытки прячутся за 1.6% проигрышей, хватает ли
//  выборки хоть на какой-то вывод. Обычно ломается что-то одно, и видно, что.
//
//  ⚠️ Инструмент НЕ доказывает обман. Он переводит рекламу в набор следствий,
//  которые автор либо подтвердит цифрой, либо нет. Отсутствие знаменателя (на
//  какой капитал? какой размер сделки?) — сам по себе ответ.
//
//  ЧТО СЧИТАЕТСЯ
//    1. Темп       — сделок в час, секунд на сделку.
//    2. Payoff     — при заявленном winrate: насколько велик должен быть средний
//                    убыток. Высокий winrate всегда оплачен размером проигрышей;
//                    в промо показывают только первое.
//    3. Комиссии   — для набора гипотез о размере сделки: оборот, комиссия и
//                    какой ВАЛОВЫЙ % нужно снимать со сделки. Здесь чаще всего и
//                    рвётся: у «арбитража» валовый эдж — сотые доли процента.
//    4. Просадка   — сверяет заявленный max DD с размером одного убытка. Если
//                    один проигрыш больше всей просадки — числа несовместимы.
//    5. Статистика — t-стат и необходимое n. Даже честные числа на маленьком
//                    окне ничего не доказывают (см. docs/journal-decomposition).
//
//  Запуск:
//    node tools/claimCheck.mjs --trades 1420 --winrate 98.4 --profit 38420.5 \
//                              --hours 4 --dd 0.4
//    node tools/claimCheck.mjs --trades 400 --winrate 52 --profit 28 --capital 50 \
//                              --notional 50 --sd 2.79
//
//  Флаги: --trades --winrate(%) --profit($) --hours --fee(% с ноги, деф. 0.045)
//         --capital($, опц.) --notional($ на сделку, опц.) --dd(%, опц.)
//         --sd(% на сделку, деф. 2.79 — из своего журнала)
// ─────────────────────────────────────────────────────────────────────────────

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const num = (k, d) => { const v = arg(k, null); return v === null ? d : parseFloat(v); };

const TRADES   = num('trades', null);
const WINRATE  = num('winrate', null);      // %
const PROFIT   = num('profit', null);       // $ итого
const HOURS    = num('hours', null);
const FEE_PCT  = num('fee', 0.045);         // % с ноги (HL taker)
const CAPITAL  = num('capital', null);      // $
const NOTIONAL = num('notional', null);     // $ на сделку
const DD_PCT   = num('dd', null);           // % заявленной макс. просадки
const SD_PCT   = num('sd', 2.79);           // % — sd доходности сделки

if (!(TRADES > 0) || PROFIT === null) {
  console.error('\n⚠️  нужны минимум --trades и --profit\n   node tools/claimCheck.mjs --trades 1420 --winrate 98.4 --profit 38420.5 --hours 4 --dd 0.4\n');
  process.exit(1);
}

const usd = (v) => {
  const a = Math.abs(v);
  const s = v < 0 ? '−' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${a.toFixed(2)}`;
};
const h = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 62 - t.length))}`);

const perTrade = PROFIT / TRADES;

console.log(`\n╔═══ CLAIM-CHECK ═══`);
console.log(`  заявлено: ${TRADES} сделок · ${WINRATE !== null ? WINRATE + '% winrate · ' : ''}${usd(PROFIT)}` +
            `${HOURS ? ` за ${HOURS}ч` : ''}${DD_PCT !== null ? ` · max DD ${DD_PCT}%` : ''}`);
console.log(`  комиссия для расчёта: ${FEE_PCT}% с ноги (${(FEE_PCT * 2).toFixed(3)}% круг)`);

// ── 1. Темп ─────────────────────────────────────────────────────────────────
if (HOURS > 0) {
  h('ТЕМП');
  const perHour = TRADES / HOURS;
  console.log(`  ${perHour.toFixed(0)} сделок/час · одна каждые ${(3600 / perHour).toFixed(1)} сек`);
  console.log(`  средняя прибыль на сделку: ${usd(perTrade)}`);
  if (perHour > 60) console.log('  → это не ручная торговля и не «настроил и забыл»: нужен алго + аптайм');
}

// ── 2. Payoff: чем оплачен высокий winrate ──────────────────────────────────
// m = w·avgWin − (1−w)·avgLoss  ⇒  avgLoss = (w·avgWin − m) / (1−w)
if (WINRATE !== null && WINRATE < 100) {
  h('PAYOFF — какого размера убытки прячутся');
  const w = WINRATE / 100;
  const wins = Math.round(TRADES * w);
  const losses = TRADES - wins;
  console.log(`  ${wins} выигрышей / ${losses} проигрышей`);
  console.log('  если средний выигрыш…      то средний убыток должен быть…   один убыток = N выигрышей');
  for (const mult of [1.2, 1.5, 2, 3, 5]) {
    const avgWin = perTrade * mult;
    const avgLoss = (w * avgWin - perTrade) / (1 - w);
    const ratio = avgLoss / avgWin;
    const flag = ratio > 20 ? '  ⚠️' : '';
    const label = `${usd(avgWin)} (${mult}× ср.)`;
    console.log(`  ${label.padEnd(24)}${usd(avgLoss).padStart(14)}${(ratio.toFixed(0) + '×').padStart(24)}${flag}`);
  }
  console.log('  → winrate без размера среднего убытка не значит ничего. В промо показывают только первое.');
}

// ── 3. Комиссии: какой валовый эдж нужен ────────────────────────────────────
h('КОМИССИИ — какой ВАЛОВЫЙ эдж нужен со сделки');
const sizes = NOTIONAL ? [NOTIONAL] : [1e3, 1e4, 1e5, 1e6];
console.log('  размер сделки      оборот      комиссия     нужно валом    = % со сделки');
for (const size of sizes) {
  const turnover = size * TRADES;
  const fees = turnover * (FEE_PCT * 2) / 100;
  const gross = PROFIT + fees;
  const grossPct = gross / turnover * 100;
  const flag = grossPct > 0.5 ? '  ⚠️ не «арбитраж»' : grossPct < 0.02 ? '  ⚠️ тоньше спреда' : '';
  console.log(`  ${usd(size).padStart(12)} ${usd(turnover).padStart(12)} ${usd(fees).padStart(12)} ` +
              `${usd(gross).padStart(13)} ${grossPct.toFixed(3).padStart(11)}%${flag}`);
}
console.log('  → у настоящего арбитража валовый эдж — сотые доли процента. Если для схождения');
console.log('    цифр нужны десятые или целые проценты — это не арбитраж, а направленная ставка.');

// ── 4. Просадка против размера убытка ───────────────────────────────────────
if (DD_PCT !== null) {
  h('ПРОСАДКА');
  if (CAPITAL) {
    const ddUsd = CAPITAL * DD_PCT / 100;
    console.log(`  ${DD_PCT}% от ${usd(CAPITAL)} = ${usd(ddUsd)} — это потолок для ОДНОГО убытка`);
    if (WINRATE !== null && WINRATE < 100) {
      const w = WINRATE / 100;
      const avgLoss = (w * perTrade * 2 - perTrade) / (1 - w); // при avgWin = 2× среднего
      const verdict = avgLoss > ddUsd ? '⚠️ НЕСОВМЕСТИМО: один убыток больше всей заявленной просадки' : '✅ совместимо';
      console.log(`  оценка среднего убытка: ${usd(avgLoss)} → ${verdict}`);
    }
  } else {
    console.log(`  ⚠️ ${DD_PCT}% ОТ ЧЕГО? Капитал не назван — процент просадки не связан с ${usd(PROFIT)}.`);
    console.log('     Это главная дыра: без знаменателя ни доходность, ни риск не вычисляются.');
    console.log(`     Прибыль ${usd(PROFIT)} может быть 0.4% на ${usd(PROFIT / 0.004)} и 400% на ${usd(PROFIT / 4)}.`);
  }
}

// ── 5. Хватает ли выборки ───────────────────────────────────────────────────
h('СТАТИСТИКА — доказывает ли выборка хоть что-то');
const base = NOTIONAL || CAPITAL;
if (base) {
  const meanPct = perTrade / base * 100;
  const se = SD_PCT / Math.sqrt(TRADES);
  const t = meanPct / se;
  const needN = Math.ceil((2 * SD_PCT / meanPct) ** 2);
  console.log(`  средняя сделка ${meanPct.toFixed(4)}% при sd ${SD_PCT}% → t = ${t.toFixed(2)} (n=${TRADES})`);
  console.log(`  для t=2 нужно n ≈ ${needN.toLocaleString('ru-RU')} сделок`);
  console.log(`  → ${t >= 2 ? '✅ выборки формально хватает' : '⚠️ статистически неотличимо от нуля'}`);
} else {
  const needN = Math.ceil((2 * SD_PCT / 0.07) ** 2); // ориентир по своему журналу
  console.log(`  без --notional/--capital % на сделку не считается.`);
  console.log(`  ориентир: при sd ${SD_PCT}% и эдже +0.07% на сделку нужно n ≈ ${needN.toLocaleString('ru-RU')}.`);
}
if (HOURS > 0 && HOURS <= 24) {
  console.log(`  ⚠️ окно ${HOURS}ч — это ОДИН режим рынка. Сколько бы ни было сделок внутри,`);
  console.log('     out-of-sample нет: 1420 сделок за 4 часа — это одно наблюдение, а не 1420.');
}

// ── Что спросить у автора ───────────────────────────────────────────────────
h('ЧТО СПРОСИТЬ У АВТОРА');
const qs = [
  'На какой капитал эта прибыль? (без знаменателя % просадки бессмысленен)',
  'Средний размер сделки и суммарный оборот? (проверяется комиссия)',
  'Размер САМОГО БОЛЬШОГО убытка и средний убыток?',
  'Тот же отчёт за другой день / другой месяц? (out-of-sample)',
  'Выписка биржи или API-ключ только на чтение — вместо скриншота?',
];
qs.forEach((q, i) => console.log(`  ${i + 1}. ${q}`));
console.log('\n  Отказ ответить на 1 и 2 — уже ответ. Эти числа есть у любого, кто реально торговал.\n');
