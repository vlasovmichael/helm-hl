// Правила трёх форвард-гипотез, предзаявленных 31.08.2026.
//
// Запуск: npm test
//
// Эти тесты стерегут не поведение, а ЗАМОРОЗКУ. Реестр гипотез ссылается на
// конкретные значения параметров; правка любого из них превращает гипотезу в
// другую, но выглядит как безобидный рефакторинг. Через четыре месяца, при
// оценке, отличить одно от другого будет уже нечем — кроме этого файла.
//
// Что закрыто:
//  - точные значения замороженных параметров всех трёх правил
//  - пороги остановки в коллекторе совпадают с реестром
//  - парная схема H1 отдаёт обе ноги и их разницу
//  - неоднозначный бар (задет и стоп, и цель) засчитывается как СТОП

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { WIDE_STOP, SESSION_REV, SQUEEZE, RULES, findWideStop } from "../tools/forwardRules.mjs";

test("параметры правил заморожены ровно в предзаявленных значениях", () => {
  assert.deepEqual({ ...WIDE_STOP }, {
    id: "wide-stop-premium-4h",
    tf: "4h", rr: 2, maxh: 96, rtPct: 0.10,
    atrPeriod: 14, multWide: 1.5, multNarrow: 0.5, touchPct: 0.3,
  });
  assert.deepEqual({ ...SESSION_REV }, {
    id: "session-open-reversal",
    asiaStartUTC: 0, asiaEndUTC: 7, rr: 1.5, maxh: 32,
    minMovePct: 1.2, stopBuffer: 0.25, rtPct: 0.10,
  });
  assert.deepEqual({ ...SQUEEZE }, {
    id: "squeeze-expansion-4h",
    tf: "4h", lookback: 20, pct: 0.25,
    rr: 2, maxh: 96, minRangePct: 1.5, rtPct: 0.10,
  });
});

test("объекты параметров действительно заморожены", () => {
  // Object.freeze — не косметика: без неё случайная мутация в рантайме поменяла
  // бы правило посреди накопления, и журнал стал бы смесью двух гипотез.
  for (const p of [WIDE_STOP, SESSION_REV, SQUEEZE]) assert.ok(Object.isFrozen(p));
});

test("пороги в коллекторе совпадают с реестром гипотез", () => {
  // Две копии порога (коллектор и реестр) обязаны сходиться. Разойдись они —
  // оценка запустится не там, где заявлено, и это уже другой тест.
  const registry = JSON.parse(readFileSync("data/hypotheses/registry.json", "utf8"));
  const src = readFileSync("scripts/forwardMulti.mjs", "utf8");
  for (const [id, expected] of [
    ["wide-stop-premium-4h", 700],
    ["session-open-reversal", 60],
    ["squeeze-expansion-4h", 1200],
  ]) {
    const h = registry.hypotheses.find((x) => x.id === id);
    assert.ok(h, `гипотеза ${id} должна быть в реестре`);
    assert.equal(h.stopRule.n, expected, `порог ${id} в реестре`);
    assert.match(src, new RegExp(`'${id}':\\s*\\{\\s*n:\\s*${expected}\\b`), `порог ${id} в коллекторе`);
  }
});

test("RULES перечисляет все три правила и их find-функции", () => {
  assert.equal(RULES.length, 3);
  for (const r of RULES) assert.equal(typeof r.find, "function");
  assert.deepEqual(RULES.map((r) => r.id).sort(), [
    "session-open-reversal", "squeeze-expansion-4h", "wide-stop-premium-4h",
  ]);
});

// ── синтетический ряд: ровный рост, чтобы EMA20 ушла выше EMA50 ──
function risingBars(n) {
  const bars = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    px *= 1.0004;
    const t = i * 15 * 60_000;
    bars.push({ t, o: px, h: px * 1.004, l: px * 0.996, c: px });
  }
  return bars;
}

test("парная схема отдаёт обе ноги и их разницу", () => {
  const trades = findWideStop("TEST", risingBars(3000));
  // На гладком ряду сделок может не быть — тест о ФОРМЕ записи, если они есть.
  for (const t of trades) {
    assert.ok(t.wide && t.narrow, "обе ноги обязательны — половина пары ничего не сравнивает");
    assert.ok(t.wide.riskPct > t.narrow.riskPct, "широкая нога обязана быть шире узкой");
    assert.equal(t.diffNet, t.wide.rNet - t.narrow.rNet);
    assert.equal(t.wide.riskPct / t.narrow.riskPct, WIDE_STOP.multWide / WIDE_STOP.multNarrow);
  }
});

test("неоднозначный бар засчитывается как стоп, а не как цель", () => {
  // Бар, накрывающий и стоп, и цель. Порядок внутри бара неизвестен, и если
  // засчитывать цель, правило получит эдж из незнания — ровно так рисуются
  // красивые бэктесты на тесных стопах.
  const bars = risingBars(2000);
  const wide = bars.slice();
  for (let i = 1500; i < wide.length; i++) {
    wide[i] = { ...wide[i], h: wide[i].c * 1.5, l: wide[i].c * 0.5 };
  }
  for (const t of findWideStop("TEST", wide)) {
    if (t.entryT >= wide[1500].t) {
      assert.notEqual(t.wide.why, "target", "на баре-обжоре цель засчитывать нельзя");
    }
  }
});
