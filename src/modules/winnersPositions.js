import { hlInfo, HL_PRIORITY } from "../core/hlClient.js";

// ─────────────────────────────────────────────────
//  winnersPositions — что открыто у «Гениев Уолл-стрит» прямо сейчас
// ─────────────────────────────────────────────────
// Чтение открытых позиций трёх замороженных адресов. Общий код для двух
// потребителей: витрины /api/winners/positions (по клику) и сторожа
// winnersWatch (по таймеру, шлёт пуш на открытие/закрытие). Держим в одном
// месте, чтобы обход HIP-3 ниже не пришлось чинить дважды.
//
// Наблюдение, а НЕ вход в предзаявленный тест: форвардный вердикт по-прежнему
// считает только tools/winners.mjs track по снимкам лидерборда.
//
// Вес запросов: адрес × clearinghouseState = 2 единицы, LOW-приоритет — живой
// бот в очереди всегда впереди.
//
// 🚨 LOW ждёт бюджета не дольше 1.5с и штатно отваливается с
// WeightBudgetTimeoutError — так задумано с инцидента 31.07 (косметика не имеет
// права копить очередь и тянуть за собой тик). Значит вызывающий ОБЯЗАН
// пережить отказ: адреса опрашиваются по одному, а не залпом.

// 🚨 Одного clearinghouseState МАЛО. У HL кроме основного перп-DEX'а есть
// builder-DEX'ы (HIP-3): xyz с акциями и товарами, flx, vntl, hyna, km, abcd,
// cash, para, mkts. У каждого своя маржа и свой clearinghouseState, и без
// параметра `dex` их позиции в ответ НЕ попадают. Первая версия витрины из-за
// этого соврала: показала у адреса 0x4801 только брошенные крипто-мешки на
// −$74k, тогда как вся его работа идёт на xyz (акции и ETF, 25 тикеров за
// последние 2000 сделок) и там отдельный счёт с плюсовыми шортами.
//
// Какие DEX'ы опрашивать, узнаём из userFills: тикеры оттуда приходят с
// префиксом («xyz:EWZ»), так что список DEX'ов адреса читается из его же
// сделок. Это тяжёлый запрос (вес 20 против 2 у clearinghouseState), поэтому
// он кэшируется на 6 часов — набор площадок у человека меняется редко.

const DEX_TTL_MS = 6 * 3_600_000;
const dexCache = new Map(); // address → { dexes: string[], at }

const hlLow = (body, label) =>
  hlInfo(body, { label, timeoutMs: 8_000, maxRetries: 2, priority: HL_PRIORITY.LOW });

/** DEX'ы, на которых адрес вообще торговал: '' = основной, остальные по имени. */
async function dexesFor(address) {
  const hit = dexCache.get(address);
  if (hit && Date.now() - hit.at < DEX_TTL_MS) return hit.dexes;

  const fills = await hlLow({ type: "userFills", user: address }, "dash/winnersDexes");
  const dexes = [""];
  for (const f of Array.isArray(fills) ? fills : []) {
    const i = String(f?.coin ?? "").indexOf(":");
    if (i > 0) {
      const dex = f.coin.slice(0, i);
      if (!dexes.includes(dex)) dexes.push(dex);
    }
  }
  dexCache.set(address, { dexes, at: Date.now() });
  return dexes;
}

function parsePositions(state, dex) {
  return (state?.assetPositions ?? [])
    .map((ap) => ap?.position)
    .filter((p) => p?.coin && parseFloat(p.szi ?? "0") !== 0)
    .map((p) => {
      const szi = parseFloat(p.szi ?? "0");
      const entryPx = parseFloat(p.entryPx ?? "0");
      const lev = p.leverage?.value != null ? parseFloat(p.leverage.value) : null;
      const liqPx = p.liquidationPx != null ? parseFloat(p.liquidationPx) : null;
      return {
        coin: p.coin,
        dex: dex || "main",
        side: szi < 0 ? "SHORT" : "LONG",
        szi: Math.abs(szi),
        entryPrice: entryPx,
        sizeUsd: Math.abs(szi) * entryPx,
        unrealizedPnl: parseFloat(p.unrealizedPnl ?? "0"),
        leverage: Number.isFinite(lev) ? lev : null,
        leverageType: p.leverage?.type ?? null,
        liquidationPrice: Number.isFinite(liqPx) ? liqPx : null,
      };
    });
}

export async function fetchPositions(address) {
  // Список DEX'ов не обязателен: если userFills не дождался бюджета, показываем
  // хотя бы основной счёт, честно пометив, что смотрели не везде.
  let dexes = [""];
  let partial = false;
  try {
    dexes = await dexesFor(address);
  } catch {
    partial = true;
  }

  const positions = [];
  const venues = [];
  let equity = 0;
  for (const dex of dexes) {
    const state = await hlLow(
      dex ? { type: "clearinghouseState", user: address, dex } : { type: "clearinghouseState", user: address },
      "dash/winnersPos",
    );
    const eq = parseFloat(state?.marginSummary?.accountValue ?? "NaN");
    const got = parsePositions(state, dex);
    positions.push(...got);
    if (Number.isFinite(eq)) equity += eq;
    // Пустые площадки в шапку не тащим — иначе список из девяти нулей.
    if (got.length || (Number.isFinite(eq) && eq > 0))
      venues.push({ dex: dex || "main", equity: Number.isFinite(eq) ? eq : null, positions: got.length });
  }
  positions.sort((a, b) => b.sizeUsd - a.sizeUsd);

  const notional = positions.reduce((s, p) => s + p.sizeUsd, 0);
  return {
    address,
    equity,
    notional,
    // Плечо по счёту целиком: номинал позиций к эквити. Одна цифра, по которой
    // видно, «сидит» адрес или крутится.
    grossLeverage: equity > 0 ? notional / equity : null,
    unrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    venues,
    partial,
    positions,
  };
}


