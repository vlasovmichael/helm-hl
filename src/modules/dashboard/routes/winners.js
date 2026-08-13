// ─────────────────────────────────────────────────
//  Winners route — витрина предзаявленного теста «а если взять не тысячу, а троих»
// ─────────────────────────────────────────────────
// Список адресов заморожен 13.08.2026 (docs/winners-preregistration.json),
// форвард считает tools/winners.mjs track по накопленным снимкам лидерборда.
//
// Живого бота не касается: только чтение файлов с диска.
//
// GET /api/winners            — витрина теста
// GET /api/winners/positions  — что у отобранных ОТКРЫТО прямо сейчас

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { hlInfo, HL_PRIORITY } from "../../../core/hlClient.js";
import { logger } from "../../../core/logger.js";

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

// ─── что у отобранных открыто прямо сейчас ──────────────────────────────────
//
// Наблюдение, а НЕ вход в тест: клик по адресу разворачивает его открытые
// позиции (монета, сторона, плечо, нереализованный PnL). Форвардный вердикт
// по-прежнему считает только tools/winners.mjs track по снимкам лидерборда —
// увиденное здесь на него не влияет и повлиять не должно, иначе заморозка
// списка теряет смысл.
//
// 🚨 Именно эта таблица показывает, что такое «PnL с плавающей прибылью»:
// адрес может висеть в лонге с минусом в десятки тысяч, пока лидерборд
// рисует ему красивую месячную доходность. Тот же капкан держателя, из-за
// которого в правила отбора добавлен фильтр оборота.
//
// Вес запросов: 3 адреса × clearinghouseState раз в минуту, LOW-приоритет —
// живой бот в очереди всегда впереди.

const POS_TTL_MS = 60_000;
let posCache = { payload: null, loadedAt: 0 };

async function fetchPositions(address) {
  const state = await hlInfo(
    { type: "clearinghouseState", user: address },
    { label: "dash/winnersPos", timeoutMs: 8_000, maxRetries: 2, priority: HL_PRIORITY.LOW },
  );
  const positions = (state?.assetPositions ?? [])
    .map((ap) => ap?.position)
    .filter((p) => p?.coin && parseFloat(p.szi ?? "0") !== 0)
    .map((p) => {
      const szi = parseFloat(p.szi ?? "0");
      const entryPx = parseFloat(p.entryPx ?? "0");
      const lev = p.leverage?.value != null ? parseFloat(p.leverage.value) : null;
      const liqPx = p.liquidationPx != null ? parseFloat(p.liquidationPx) : null;
      return {
        coin: p.coin,
        side: szi < 0 ? "SHORT" : "LONG",
        szi: Math.abs(szi),
        entryPrice: entryPx,
        sizeUsd: Math.abs(szi) * entryPx,
        unrealizedPnl: parseFloat(p.unrealizedPnl ?? "0"),
        leverage: Number.isFinite(lev) ? lev : null,
        leverageType: p.leverage?.type ?? null,
        liquidationPrice: Number.isFinite(liqPx) ? liqPx : null,
      };
    })
    .sort((a, b) => b.sizeUsd - a.sizeUsd);

  const equity = parseFloat(state?.marginSummary?.accountValue ?? "NaN");
  const notional = positions.reduce((s, p) => s + p.sizeUsd, 0);
  return {
    address,
    equity: Number.isFinite(equity) ? equity : null,
    notional,
    // Плечо по счёту целиком: номинал позиций к эквити. Одна цифра, по которой
    // видно, «сидит» адрес или крутится.
    grossLeverage: Number.isFinite(equity) && equity > 0 ? notional / equity : null,
    unrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    positions,
  };
}

export async function handleWinnersPositions(_req, res) {
  const now = Date.now();
  if (posCache.payload && now - posCache.loadedAt < POS_TTL_MS) {
    res.json(posCache.payload);
    return;
  }
  if (!existsSync(FREEZE_FILE)) {
    res.json({ ok: false, reason: "not-frozen" });
    return;
  }

  let addresses;
  try {
    addresses = JSON.parse(readFileSync(FREEZE_FILE, "utf8")).selected.map((s) => s.address);
  } catch (err) {
    res.json({ ok: false, reason: `read: ${String(err?.message || err)}` });
    return;
  }

  // Один упавший адрес не должен гасить остальные — отдаём, что получилось.
  const settled = await Promise.allSettled(addresses.map(fetchPositions));
  const accounts = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { address: addresses[i], error: String(r.reason?.message || r.reason) },
  );
  const failed = accounts.filter((a) => a.error).length;
  if (failed) logger.debug(`[Dashboard] winners positions: ${failed}/${addresses.length} не ответили`);

  const payload = { ok: true, fetchedAt: now, accounts };
  posCache = { payload, loadedAt: now };
  res.json(payload);
}
