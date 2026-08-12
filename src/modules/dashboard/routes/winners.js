// ─────────────────────────────────────────────────
//  Winners route — витрина предзаявленного теста «а если взять не тысячу, а троих»
// ─────────────────────────────────────────────────
// Список адресов заморожен 13.08.2026 (docs/winners-preregistration.json),
// форвард считает tools/winners.mjs track по накопленным снимкам лидерборда.
//
// Живого бота не касается: только чтение файлов с диска.
//
// GET /api/winners

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FREEZE_FILE = join("docs", "winners-preregistration.json");
const RESULT_FILE = join("data", "winners-forward.json");

const CACHE_TTL_MS = 3_600_000; // пересчёт кроном раз в сутки, чаще смотреть незачем
let cache = { payload: null, loadedAt: 0 };

export function handleWinners(_req, res) {
  const now = Date.now();
  if (cache.payload && now - cache.loadedAt < CACHE_TTL_MS) {
    res.json(cache.payload);
    return;
  }

  if (!existsSync(FREEZE_FILE)) {
    res.json({ ok: false, reason: "not-frozen" });
    return;
  }

  let payload;
  try {
    const freeze = JSON.parse(readFileSync(FREEZE_FILE, "utf8"));
    const forward = existsSync(RESULT_FILE) ? JSON.parse(readFileSync(RESULT_FILE, "utf8")) : null;

    payload = {
      ok: true,
      frozenAt: freeze.frozenAt,
      poolSize: freeze.poolSize,
      selectionFrom: freeze.selectionSnapshots.from,
      selectionTo: freeze.selectionSnapshots.to,
      interimDate: freeze.interimDate,
      decisionDate: freeze.decisionDate,
      successEdgeBp: freeze.rules.successEdgeBp,
      // Условия отбора идут в витрину целиком: через три месяца никто не
      // вспомнит, по каким правилам выбирали, а без них цифры не читаются.
      rules: {
        minAccountValue: freeze.rules.minAccountValue,
        minTurnover: freeze.rules.minTurnover,
        maxPlausibleEdgeBp: freeze.rules.maxPlausibleEdgeBp,
      },
      selected: (forward?.selected ?? freeze.selected.map((s) => ({
        address: s.address,
        selectionEdgeBp: Math.round(s.monthEdgeBp * 10) / 10,
        forwardEdgeBp: null,
        forwardPnl: null,
        forwardVolume: null,
      }))),
      forward: forward
        ? {
            from: forward.from,
            to: forward.to,
            days: forward.days,
            selectedMedianBp: forward.selectedMedianBp,
            controlMedianBp: forward.controlMedianBp,
            controlCount: forward.controlCount,
            verdict: forward.verdict,
            computedAt: forward.computedAt,
          }
        : null,
    };
  } catch (err) {
    res.json({ ok: false, reason: `read: ${String(err?.message || err)}` });
    return;
  }

  cache = { payload, loadedAt: now };
  res.json(payload);
}
