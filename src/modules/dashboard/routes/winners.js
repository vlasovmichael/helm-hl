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
import { logger } from "../../../core/logger.js";
import { fetchPositions } from "../../winnersPositions.js";

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
//
// 🚨 LOW ждёт бюджета не дольше 1.5с и штатно отваливается с
// WeightBudgetTimeoutError — так задумано с инцидента 31.07 (косметика не имеет
// права копить очередь и тянуть за собой тик). Значит витрина ОБЯЗАНА пережить
// отказ: адреса опрашиваются по одному, а не залпом, и последний удачный ответ
// по каждому хранится отдельно и показывается с пометкой возраста. «Данные
// 3 мин назад» здесь честнее, чем «не ответил»: позиции живут часами, а вердикт
// теста они всё равно не считают.

const POS_TTL_MS = 60_000;
// Затор → пробуем чаще, чем раз в минуту, но не на каждый клик.
const POS_RETRY_TTL_MS = 10_000;
let posCache = { payload: null, loadedAt: 0, ttl: POS_TTL_MS };
const lastGood = new Map(); // address → { account, at }

export async function handleWinnersPositions(_req, res) {
  const now = Date.now();
  if (posCache.payload && now - posCache.loadedAt < posCache.ttl) {
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

  // По одному, а не залпом: три параллельных запроса конкурируют за один и тот
  // же LOW-бюджет и валят друг друга по дедлайну — залп при заторе не быстрее,
  // он просто отваливается втрое чаще. Один упавший адрес не гасит остальные.
  const accounts = [];
  let refused = 0;
  for (const address of addresses) {
    try {
      const account = await fetchPositions(address);
      lastGood.set(address, { account, at: Date.now() });
      accounts.push(account);
    } catch (err) {
      refused++;
      const prev = lastGood.get(address);
      accounts.push(
        prev
          ? { ...prev.account, stale: true, staleAgeMs: Date.now() - prev.at }
          : { address, error: String(err?.message || err) },
      );
    }
  }
  if (refused)
    logger.debug(
      `[Dashboard] winners positions: ${refused}/${addresses.length} не дождались бюджета` +
        `${accounts.some((a) => a.stale) ? " (показан последний удачный ответ)" : ""}`,
    );

  const payload = { ok: true, fetchedAt: now, accounts };
  // Свежими данными живём минуту; если хоть один адрес отвалился — перепробуем
  // через 10 секунд, затор в пуле обычно короче этого.
  posCache = { payload, loadedAt: now, ttl: refused ? POS_RETRY_TTL_MS : POS_TTL_MS };
  res.json(payload);
}
