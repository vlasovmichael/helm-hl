// ─────────────────────────────────────────────────
//  Pre-trade — карточка решения ПЕРЕД входом
// ─────────────────────────────────────────────────
// Порядок вопросов здесь обратный привычному. Привычный — «какая монета, куда
// пойдёт, где вход»; все три звена в журнале нулевые или отрицательные:
// направление в цене не предсказуемо (автокорреляция −0.01), витрина рывков
// хуже случайного входа (34.6% против 41.1%), сторона входа не значит ничего
// (n=61, p=0.993).
//
// Предсказуема на тех же данных ровно одна вещь — АМПЛИТУДА (0.25, у 100%
// монет). Поэтому карточка отвечает на вопросы, у которых ответ есть:
// сколько монета проходит, сколько стоит круг на ней, какая пара цель/стоп
// на ней окупается, какой размер держит риск и сколько попыток сегодня ещё
// оплачено бюджетом комиссий.
//
// 🚨 Сторону карточка НЕ подсказывает и подсказывать не может. Строка «coin
// flip» стоит здесь намеренно: витрина, делающая вид, что знает направление,
// дороже отсутствующей.
//
// Своего счёта не ведёт: калибратор, дневной лимит и баланс уже посчитаны
// другими модулями, тут только сборка в одно решение.

import { readCache } from '../../calibrator.js';
import { getLastDailyRiskStatus } from '../../dailyRisk.js';
import { getCachedAccountValueSync } from '../../../core/balanceCache.js';
import { config } from '../../../core/config.js';
import { liveCoinSnapshot } from './screen.js';

// Разрыв между «нужно попаданий для нуля» и «даёт рынок». Порог не круглый:
// 5 п.п. — это примерно ширина доверительного интервала самой сетки, ниже неё
// разница неотличима от шума.
const GAP_REACHABLE = 5;
const GAP_HOPELESS = 10;

const pick = (grid, mode) => grid.reduce((a, b) => (gapOf(b, mode) < gapOf(a, mode) ? b : a));
const gapOf = (g, mode) => (mode === 'M' ? g.gapM : g.gapT);
const needOf = (g, mode) => (mode === 'M' ? g.needM : g.needT);
const expOf = (g, mode) => (mode === 'M' ? g.eM : g.eT);
const costOf = (c, mode) => (mode === 'M' ? c.costMaker : c.costTaker);
const shareOf = (c, mode) => (mode === 'M' ? c.shareMaker : c.shareTaker);

function verdict(gap) {
  if (gap <= 0) return { tone: 'ok', label: 'pays for itself', note: 'The market clears this pair on its own.' };
  if (gap <= GAP_REACHABLE) return { tone: 'warn', label: 'needs an edge', note: `You must be ${gap.toFixed(1)} pp better than chance for this to break even.` };
  if (gap <= GAP_HOPELESS) return { tone: 'warn', label: 'expensive', note: `${gap.toFixed(1)} pp above what the market gives — a large edge to carry.` };
  return { tone: 'bad', label: 'does not pay', note: `${gap.toFixed(1)} pp above chance. No entry point fixes a gap this wide.` };
}

export function handlePretrade(req, res) {
  const cache = readCache();
  if (!cache) return res.json({ ok: false, reason: 'not-built' });

  const mode = req.query.mode === 'M' ? 'M' : 'T';
  const coins = cache.coins || {};

  // Дешевизна попытки = доля круга в типичном размахе монеты. Это и есть
  // замена отбору по рывку: там сортировка вычитала, здесь она хотя бы
  // измеряет то, что от монеты зависит.
  const ranked = Object.entries(coins)
    .map(([name, c]) => {
      // Тот же живой круг, что и в карточке: иначе список и открытая монета
      // считались бы по разным спредам и противоречили друг другу.
      const lv = liveCoinSnapshot(name);
      const half = lv?.spreadBp != null ? lv.spreadBp / 2 : null;
      const cost = half == null
        ? costOf(c, mode)
        : mode === 'M' ? cache.feeM + cache.feeT + half : 2 * (cache.feeT + half);
      return {
        coin: name, vlm: c.vlm, atr: c.atr, cost,
        share: c.atr > 0 ? (cost / c.atr) * 100 : shareOf(c, mode),
        gap: gapOf(pick(c.grid, mode), mode),
      };
    })
    .sort((a, b) => a.share - b.share);

  const want = String(req.query.coin || ranked[0]?.coin || '').toUpperCase();
  const c = coins[want];

  const equity = getCachedAccountValueSync();
  const day = getLastDailyRiskStatus();
  const riskPct = Number(req.query.riskPct) > 0 ? Number(req.query.riskPct) : 1;
  const riskUsd = equity > 0 ? (equity * riskPct) / 100 : null;

  if (!c) {
    return res.json({
      ok: true, mode, built: cache.built, ranked, coin: null,
      // Отсутствие монеты в кэше — это ответ, а не пробел: калибратор берёт
      // только оборот выше $3M, и всё, что ниже, слишком широкое для попытки.
      missing: want || null,
      day: dayBlock(day, equity, null),
    });
  }

  const best = pick(c.grid, mode);
  const gap = gapOf(best, mode);

  // 🚨 Спред в сетке — двенадцатичасовой давности, а на неликвиде он меняется
  // за минуты. Круг пересчитывается по живому спреду; сетка целей и стопов
  // остаётся прежней — часовой размах живёт неделями, дёргать его нечем.
  const live = liveCoinSnapshot(want);
  const halfLive = live?.spreadBp != null ? live.spreadBp / 2 : null;
  const costLive = halfLive == null
    ? costOf(c, mode)
    : mode === 'M'
      ? cache.feeM + cache.feeT + halfLive
      : 2 * (cache.feeT + halfLive);

  // Номинал из риска и стопа: стоп в бп — это и есть доля номинала, которой
  // рискуешь. Обратный порядок (сначала размер, потом стоп) — то, как теряют
  // худшие 5% сделок журнала (−363 п.п. против +226 у остальных).
  const notional = riskUsd && best.stp > 0 ? riskUsd / (best.stp / 1e4) : null;

  // Сколько попыток ещё оплачено бюджетом комиссий: минус по PnL решает рынок,
  // комиссии решает частота — единственная статья, растущая от числа сделок.
  const feeBudgetUsd = day && equity > 0 && config.trading.dailyFeeBudgetPct > 0
    ? (equity * config.trading.dailyFeeBudgetPct) / 100
    : null;
  const costUsd = notional ? (notional * costLive) / 1e4 : null;
  const triesLeft = feeBudgetUsd && costUsd > 0
    ? Math.max(0, Math.floor((feeBudgetUsd - (day?.feesUsd ?? 0)) / costUsd))
    : null;

  res.json({
    ok: true, mode, built: cache.built, ranked,
    coin: {
      name: want, vlm: c.vlm, px: c.px,
      atr: c.atr, half: halfLive ?? c.half,
      cost: costLive, share: c.atr > 0 ? (costLive / c.atr) * 100 : shareOf(c, mode),
      // Возраст сетки — чтобы витрина не выдавала вчерашний расчёт за сейчас.
      live: live ? { price: live.price, ageMs: live.ageMs } : null,
      gridAgeMs: Date.now() - cache.built,
      horizonH: cache.horizonH,
      best: {
        tgt: best.tgt, stp: best.stp, mt: best.mt, ms: best.ms,
        hit: best.hit, ci: best.ci, need: needOf(best, mode), gap,
        expected: expOf(best, mode), n: best.n,
      },
      verdict: verdict(gap),
      size: { riskPct, riskUsd, notional, costUsd },
    },
    day: dayBlock(day, equity, triesLeft),
  });
}

function dayBlock(day, equity, triesLeft) {
  const budgetPct = config.trading.dailyFeeBudgetPct;
  return {
    known: !!day,
    halted: !!day?.halted,
    netUsd: day?.netUsd ?? null,
    feesUsd: day?.feesUsd ?? null,
    fills: day?.fillCount ?? null,
    limitUsd: day?.limitUsd ?? null,
    feePct: day?.feePct ?? null,
    feeBudgetPct: budgetPct || null,
    feeExceeded: !!day?.feeExceeded,
    equity: equity > 0 ? equity : null,
    triesLeft,
  };
}
