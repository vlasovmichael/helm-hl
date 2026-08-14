// ─────────────────────────────────────────────────
//  xvenuePaper — бумажный бот на межбиржевом расхождении
// ─────────────────────────────────────────────────
// Что это. Депозит $100 делится между двумя биржами, бот ждёт расхождения выше
// издержек и торгует его: покупает там, где дешевле, продаёт там, где дороже,
// закрывает обе ноги когда расхождение схлопнулось. Ордеров не ставит —
// считает на живом потоке цен от crossVenueCollector.
//
// ── ГЛАВНОЕ: ордер нельзя отозвать ─────────────────────────────────────────
// Это единственное, что отличает честный симулятор от рисующего прибыль.
// Бот видит расхождение в момент t. Ордера доезжают до бирж в t+LATENCY и
// исполняются по цене, которая будет ТОГДА, а не по той, что он видел.
// Если за эти 220 мс расхождение схлопнулось — это не «сделка не состоялась»,
// это вход по худшей цене на обеих ногах, то есть убыток.
//
// Наивный симулятор исполняет по цене обнаружения и показывает ровно те
// красивые проценты, ради которых такие боты и строят. Поэтому здесь каждая
// сделка считается ДВАЖДЫ: как было на самом деле и как показал бы наивный.
// Разница между этими двумя кривыми и есть ответ на вопрос «почему не работает».
//
// ── Второе: депозит делится, и это не формальность ─────────────────────────
// $100 — это $50 маржи на каждой бирже, потому что позиции должны стоять
// одновременно на обеих. Перебросить деньги между биржами внутри сделки
// нельзя: это часы и комиссия за вывод. Значит размер позиции ограничен не
// только стаканом, но и половиной депозита.
//
// ── Третье: размер ограничен стаканом ──────────────────────────────────────
// Берём минимум из того, что стоит на лучшей цене с обеих сторон. Глубже
// лучшей цены не лезем: это уже проскальзывание, которое здесь не моделируется
// и работает против тебя. Поэтому итог симулятора — ПОТОЛОК, а не ожидание.
//
// Включается XV_PAPER=true в коллекторе. Пишет data/xvenue/paper-YYYY-MM.jsonl
// и живой срез в тот же live.json.

const bp = (x) => x / 10_000;

export class PaperBot {
  constructor(opts = {}) {
    this.equity = Number(opts.equity ?? 100);
    this.startEquity = this.equity;
    // Задержка «отправил → исполнилось». 220 мс — замер 14.08 до бирж из
    // Европы. Именно она превращает симулятор из фантазии в замер.
    this.latencyMs = Number(opts.latencyMs ?? 220);
    // Минимальный размер ордера: ниже него биржа просто откажет.
    this.minUsd = Number(opts.minUsd ?? 10);
    // Сколько депозита готовы поставить в одну сделку (на КАЖДОЙ бирже).
    this.maxLegUsd = Number(opts.maxLegUsd ?? this.equity / 2);
    // Закрываемся, когда расхождение сжалось до этого уровня.
    this.exitBp = Number(opts.exitBp ?? 0);
    // Аварийный выход по времени: если расхождение не схлопывается, это уже
    // не арбитраж, а базисная позиция, и держать её симулятор не подписывался.
    this.maxHoldMs = Number(opts.maxHoldMs ?? 5 * 60_000);
    this.takers = opts.takers || { hl: 4.5, kr: 5, bn: 5 };

    this.pending = [];   // отправленные, ещё не доехавшие ордера
    this.open = new Map(); // coin|pair -> сделка
    this.trades = [];
    this.onTrade = opts.onTrade || (() => {});
    this.stats = {
      sent: 0, filled: 0, closed: 0,
      real: 0,      // реальный PnL, $
      naive: 0,     // сколько показал бы наивный симулятор
      slippage: 0,  // сколько съела задержка
      skippedNoRoom: 0, skippedTooSmall: 0,
    };
  }

  /** Комиссия одной ноги в долях от нотионала. */
  fee(venue) { return bp(this.takers[venue] ?? 5); }

  /**
   * Тик по паре. state = { a:{bid,ask,bidUsd,askUsd}, b:{...}, venues:[aKey,bKey] }
   * Вызывается на КАЖДОМ апдейте цены — здесь и исполнение, и решения.
   */
  onTick(coin, pair, state, costBp) {
    const now = Date.now();
    this.#settle(now, coin, pair, state);

    const key = `${coin}|${pair}`;
    const trade = this.open.get(key);

    if (trade) { this.#maybeExit(now, key, trade, state); return; }
    if (this.pending.some((p) => p.key === key)) return; // уже в пути

    // ── Вход ────────────────────────────────────────────────────────────────
    const { a, b } = state;
    const mid = (a.bid + a.ask + b.bid + b.ask) / 4;
    if (!(mid > 0)) return;

    const sides = [
      { dir: "buyB", grossBp: (a.bid - b.ask) / mid * 10_000, usd: Math.min(b.askUsd, a.bidUsd) },
      { dir: "buyA", grossBp: (b.bid - a.ask) / mid * 10_000, usd: Math.min(a.askUsd, b.bidUsd) },
    ];
    const best = sides[0].grossBp >= sides[1].grossBp ? sides[0] : sides[1];
    if (best.grossBp - costBp <= 0) return;

    // Размер: минимум из стакана и половины депозита. Депозит ограничивает
    // жёстче стакана почти всегда — на $100 это и есть суть вопроса.
    const room = Math.min(this.maxLegUsd, this.equity / 2);
    const notional = Math.min(best.usd, room);
    if (notional < this.minUsd) { this.stats.skippedTooSmall++; return; }
    if (room < this.minUsd) { this.stats.skippedNoRoom++; return; }

    this.stats.sent++;
    this.pending.push({
      key, coin, pair, dir: best.dir, notional,
      kind: "open",
      sentAt: now,
      fillAt: now + this.latencyMs,
      // Цены В МОМЕНТ РЕШЕНИЯ — только для наивного счёта и для отчёта.
      seen: { aBid: a.bid, aAsk: a.ask, bBid: b.bid, bAsk: b.ask, grossBp: best.grossBp },
      costBp,
    });
  }

  /** Исполняем всё, что доехало. Цены берём ТЕКУЩИЕ, а не те, что видели. */
  #settle(now, coin, pair, state) {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const o = this.pending[i];
      if (o.coin !== coin || o.pair !== pair || now < o.fillAt) continue;
      this.pending.splice(i, 1);
      if (o.kind === "open") this.#fillOpen(now, o, state);
      else this.#fillClose(now, o, state);
    }
  }

  #fillOpen(now, o, state) {
    const { a, b } = state;
    // dir buyB: покупаем на B по ask, продаём на A по bid. И наоборот.
    const buyPx = o.dir === "buyB" ? b.ask : a.ask;
    const sellPx = o.dir === "buyB" ? a.bid : b.bid;
    if (!(buyPx > 0) || !(sellPx > 0)) return;

    const qty = o.notional / buyPx;
    const [aV, bV] = state.venues;
    const buyVenue = o.dir === "buyB" ? bV : aV;
    const sellVenue = o.dir === "buyB" ? aV : bV;

    const feesIn = qty * buyPx * this.fee(buyVenue) + qty * sellPx * this.fee(sellVenue);

    this.stats.filled++;
    this.open.set(o.key, {
      ...o, qty, buyPx, sellPx, buyVenue, sellVenue, feesIn, openedAt: now,
      // Что БЫЛО в момент решения — чтобы показать, сколько съела задержка.
      seenBuyPx: o.dir === "buyB" ? o.seen.bAsk : o.seen.aAsk,
      seenSellPx: o.dir === "buyB" ? o.seen.aBid : o.seen.bBid,
    });
  }

  #maybeExit(now, key, trade, state) {
    const { a, b } = state;
    const mid = (a.bid + a.ask + b.bid + b.ask) / 4;
    if (!(mid > 0)) return;
    // Текущее расхождение в ту же сторону, в которую входили.
    const grossBp = trade.dir === "buyB"
      ? (a.bid - b.ask) / mid * 10_000
      : (b.bid - a.ask) / mid * 10_000;

    const converged = grossBp <= this.exitBp;
    const timedOut = now - trade.openedAt >= this.maxHoldMs;
    if (!converged && !timedOut) return;
    if (this.pending.some((p) => p.key === key && p.kind === "close")) return;

    this.pending.push({
      key, coin: trade.coin, pair: trade.pair, kind: "close",
      sentAt: now, fillAt: now + this.latencyMs, reason: timedOut ? "timeout" : "converged",
    });
  }

  #fillClose(now, o, state) {
    const t = this.open.get(o.key);
    if (!t) return;
    this.open.delete(o.key);
    const { a, b } = state;

    // Закрытие: продаём то, что купили, и выкупаем то, что продали.
    const sellBackPx = t.dir === "buyB" ? b.bid : a.bid;
    const buyBackPx = t.dir === "buyB" ? a.ask : b.ask;
    if (!(sellBackPx > 0) || !(buyBackPx > 0)) return;

    const feesOut = t.qty * sellBackPx * this.fee(t.buyVenue) + t.qty * buyBackPx * this.fee(t.sellVenue);
    // Длинная нога: купили по buyPx, продали по sellBackPx.
    // Короткая нога: продали по sellPx, выкупили по buyBackPx.
    const legLong = (sellBackPx - t.buyPx) * t.qty;
    const legShort = (t.sellPx - buyBackPx) * t.qty;
    const real = legLong + legShort - t.feesIn - feesOut;

    // ── Наивный счёт: как если бы обе ноги исполнились по ценам, которые бот
    // ВИДЕЛ в момент решения, а выход прошёл ровно при схлопывании до нуля.
    // Именно так считает симулятор, который «показывает прибыль».
    const naiveGross = t.qty * (t.seenSellPx - t.seenBuyPx);
    const naiveFees = t.qty * t.seenBuyPx * this.fee(t.buyVenue)
      + t.qty * t.seenSellPx * this.fee(t.sellVenue)
      + t.qty * t.seenBuyPx * this.fee(t.buyVenue)
      + t.qty * t.seenSellPx * this.fee(t.sellVenue);
    const naive = naiveGross - naiveFees;

    this.equity += real;
    this.stats.closed++;
    this.stats.real += real;
    this.stats.naive += naive;
    this.stats.slippage += naive - real;

    const rec = {
      t: t.sentAt, coin: t.coin, pair: t.pair, dir: t.dir,
      notional: +t.notional.toFixed(2),
      seenGrossBp: +t.seen.grossBp.toFixed(2),
      costBp: t.costBp,
      // Что расхождение стало к моменту, когда ордера доехали. Ключевое число:
      // если оно систематически меньше seenGrossBp — окно выедают быстрее,
      // чем летит ордер, и это приговор, а не невезение.
      filledGrossBp: +((t.seenSellPx - t.seenBuyPx) === 0 ? 0
        : ((t.sellPx - t.buyPx) / ((t.buyPx + t.sellPx) / 2) * 10_000)).toFixed(2),
      holdMs: now - t.openedAt,
      reason: o.reason,
      real: +real.toFixed(4),
      naive: +naive.toFixed(4),
      lostToLatency: +(naive - real).toFixed(4),
      equity: +this.equity.toFixed(2),
    };
    this.trades.push(rec);
    if (this.trades.length > 500) this.trades.shift();
    this.onTrade(rec);
  }

  snapshot() {
    return {
      equity: +this.equity.toFixed(2),
      startEquity: this.startEquity,
      pnl: +(this.equity - this.startEquity).toFixed(2),
      openTrades: this.open.size,
      pendingOrders: this.pending.length,
      ...this.stats,
      real: +this.stats.real.toFixed(4),
      naive: +this.stats.naive.toFixed(4),
      slippage: +this.stats.slippage.toFixed(4),
      recent: this.trades.slice(-10).reverse(),
    };
  }
}
