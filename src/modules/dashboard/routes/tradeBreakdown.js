// ─────────────────────────────────────────────────
//  /api/my-trades — «Разбор моих сделок»
// ─────────────────────────────────────────────────
// Декомпозиция реальных (PRODUCTION) закрытых сделок по стороне / стратегии /
// монете: win%, payoff (avgWin/|avgLoss|), expectancy, net, комиссии. Это тот
// самый «разбор своего глаза» — единственная аналитика, которой нет ни на TV, ни
// на Coinglass, потому что считается по СОБСТВЕННЫМ сделкам оператора.
//
// Разбор 12.07.2026 (356 сделок) показал: win 62% (оператор по хит-рейту хорош), но
// весь минус делают ТРИ механические вещи — комиссии от перескама, лонги без
// эджа, пара монет-дыр. Отсюда «Мои правила» ниже — чтобы не повторять.
//
// realized_pnl УЖЕ net of fees (см. database.js); fee_paid лежит отдельно только
// чтобы показать нагрузку комиссий (gross = net + fees).

import { getAllTradesMerged } from '../../../core/database.js';
import { logger } from '../../../core/logger.js';

// Правила выведены ИЗ ДАННЫХ, не из мнений. Единый источник: фронт рендерит их
// отсюда, а docs/TRADING_RULES.md — человекочитаемая копия для чтения без дашборда.
export const TRADING_RULES = [
  {
    n: 1,
    title: 'Fewer trades, bigger size',
    body: 'Fees are my entire loss and then some (across 356 trades gross was positive, net negative purely on fees). On a $50–75 account, frequency kills. Not "rack up trades" — take rare ones, by the rules.',
    metric: 'fees = 100%+ of the loss',
  },
  {
    n: 2,
    title: 'Stop as a number, before entry',
    body: 'If I cannot name the stop price before entering, I do not enter. Entering "in the void" between levels (like GRASS) means no stop, bloated risk and liquidation within a couple of percent. Stop goes BELOW a level (long) / ABOVE a level (short).',
    metric: 'payoff 0.60 → needs ≥1.5',
  },
  {
    n: 3,
    title: 'No longs',
    body: 'My edge is shorts (net +$14 over 229 trades). Longs drain (net −$25 over 127 trades, payoff 0.43). Drop longs and the book flips from red to green. A long is only ever a deliberate exception, with a journal entry saying WHY.',
    metric: 'longs −$25 / shorts +$14',
  },
  {
    n: 4,
    title: 'Ban the black-hole coins',
    body: 'HMSTR: 31 trades, −$25 — more than half of the total loss on a single coin. Once a coin has a steady loss on it, it is blacklisted, however tasty it looks.',
    metric: 'HMSTR −$25 (n=31)',
  },
  {
    n: 5,
    title: 'Once in, hand the exit to the bot',
    body: 'My skill is direction and entry. My hole is exits and risk. After entry the stop and the babysitting belong to adopt — I do not touch the position by hand at +1%. Discipline beats the feeling of being right.',
    metric: 'judge the decision, not the result',
  },
];

function computeStats(list) {
  const n = list.length;
  if (n === 0) return null;
  let net = 0, fees = 0, wins = 0, losses = 0, sumWin = 0, sumLoss = 0;
  let best = -Infinity, worst = Infinity;
  for (const r of list) {
    const p = r.realized_pnl || 0;
    net += p;
    fees += r.fee_paid || 0;
    if (p > 0) { wins++; sumWin += p; } else { losses++; sumLoss += p; }
    if (p > best) best = p;
    if (p < worst) worst = p;
  }
  const avgWin = wins ? sumWin / wins : 0;
  const avgLoss = losses ? sumLoss / losses : 0; // ≤ 0
  return {
    n,
    winPct: Math.round((wins / n) * 100),
    payoff: avgLoss !== 0 ? +(avgWin / Math.abs(avgLoss)).toFixed(2) : null,
    expectancy: +(net / n).toFixed(3),
    net: +net.toFixed(2),
    gross: +(net + fees).toFixed(2),
    fees: +fees.toFixed(2),
    avgWin: +avgWin.toFixed(3),
    avgLoss: +avgLoss.toFixed(3),
    best: +best.toFixed(2),
    worst: +worst.toFixed(2),
  };
}

function groupStats(list, keyFn) {
  const groups = new Map();
  for (const r of list) {
    const k = keyFn(r) ?? '—';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [key, rows] of groups) out.push({ key, ...computeStats(rows) });
  return out;
}

export function handleTradeBreakdown(_req, res) {
  try {
    const trades = getAllTradesMerged('PRODUCTION');
    if (trades.length === 0) {
      return res.json({ empty: true, rules: TRADING_RULES });
    }

    const overall = computeStats(trades);
    const bySide = groupStats(trades, (r) => (r.side === 'long' || r.side === 'short' ? r.side : 'no side'))
      .sort((a, b) => a.net - b.net);
    const byStrategy = groupStats(trades, (r) => r.strategy_id || 'carry')
      .sort((a, b) => b.n - a.n);
    const byCoinAll = groupStats(trades, (r) => r.coin).sort((a, b) => a.net - b.net);
    const byCoin = {
      worst: byCoinAll.slice(0, 6).map((c) => ({ coin: c.key, net: c.net, n: c.n })),
      best: byCoinAll.slice(-6).reverse().map((c) => ({ coin: c.key, net: c.net, n: c.n })),
    };

    const closes = trades.map((t) => t.closed_at || 0).filter(Boolean);
    res.json({
      period: { from: Math.min(...closes), to: Math.max(...closes) },
      overall,
      bySide,
      byStrategy,
      byCoin,
      rules: TRADING_RULES,
    });
  } catch (err) {
    logger.warn(`[Dashboard] /api/my-trades error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
}
