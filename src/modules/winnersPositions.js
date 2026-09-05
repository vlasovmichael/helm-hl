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
// WeightBudgetTimeoutError: косметика не имеет права копить очередь и тянуть за
// собой тик. Вызывающий ОБЯЗАН пережить отказ — адреса опрашиваются по одному,
// а не залпом.

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
const dexCache = new Map(); // address → { dexes: string[], openedAt: Map, at }

/**
 * Когда открылась ТЕКУЩАЯ позиция по каждой монете, из ленты филлов.
 *
 * clearinghouseState времени открытия не отдаёт вообще, и позиции на
 * builder-DEX'ах оставались без возраста: у карточки просто не было чему тикать.
 * Филлы для этого и так читаются (список площадок берётся из них же), поэтому
 * время достаётся даром — отдельного запроса не нужно.
 *
 * Якорь startPosition обязателен: без него поза, открытая до окна филлов, будет
 * выглядеть открытой на первом же попавшемся филле. Не смогли определить —
 * возвращаем null, а не догадку.
 *
 * @param {Array} fills — сырые userFills
 * @returns {Map<string, number|null>} coin → ms открытия
 */
export function positionOpenTimes(fills) {
  const EPS = 1e-9;
  const byCoin = new Map();
  for (const f of Array.isArray(fills) ? fills : []) {
    const coin = f?.coin;
    if (!coin) continue;
    if (!byCoin.has(coin)) byCoin.set(coin, []);
    byCoin.get(coin).push(f);
  }

  const out = new Map();
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => Number(a.time) - Number(b.time));
    const anchor = Number(list[0]?.startPosition);
    let net = Number.isFinite(anchor) ? anchor : 0;
    // Поза уже стояла до окна филлов — когда открылась, отсюда не узнать.
    let openedAt = Math.abs(net) > EPS ? null : undefined;

    for (const f of list) {
      const dir = String(f?.dir || '');
      const sz = Math.abs(Number(f?.sz) || 0);
      if (!sz) continue;
      const before = net;

      if (dir.includes('>')) {
        // Флип: старая поза закрылась и тут же открылась новая, обратной стороной.
        net = dir.startsWith('Long') ? -sz : sz;
        openedAt = Number(f.time);
        continue;
      }
      const isOpen = dir.startsWith('Open ');
      const isClose = dir.startsWith('Close ');
      if (!isOpen && !isClose) continue;
      const isLong = dir.includes('Long');
      net += isOpen === isLong ? sz : -sz;

      if (Math.abs(before) <= EPS && Math.abs(net) > EPS) openedAt = Number(f.time);
      else if (Math.abs(net) <= EPS) openedAt = undefined;
    }
    out.set(coin, Math.abs(net) > EPS ? (openedAt ?? null) : null);
  }
  return out;
}

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
  // Время открытия достаём из этих же филлов — второй запрос не нужен.
  dexCache.set(address, { dexes, openedAt: positionOpenTimes(fills), at: Date.now() });
  return dexes;
}

/** Время открытия позиций из кэша филлов. Пусто, если филлы ещё не читались. */
function openedAtFor(address) {
  return dexCache.get(address)?.openedAt ?? new Map();
}

function parsePositions(state, dex) {
  return (state?.assetPositions ?? [])
    .map((ap) => ap?.position)
    .filter((p) => p?.coin && parseFloat(p.szi ?? "0") !== 0)
    .map((p) => {
      const szi = parseFloat(p.szi ?? "0");
      const entryPx = parseFloat(p.entryPx ?? "0");
      // Марк с биржи: allMids не отдаёт цены builder-DEX'ов, поэтому текущую
      // цену считаем из позиции — positionValue уже посчитан по марку.
      const posVal = parseFloat(p.positionValue ?? "NaN");
      const markPx = Number.isFinite(posVal) && szi !== 0 ? posVal / Math.abs(szi) : null;
      const lev = p.leverage?.value != null ? parseFloat(p.leverage.value) : null;
      const liqPx = p.liquidationPx != null ? parseFloat(p.liquidationPx) : null;
      return {
        coin: p.coin,
        dex: dex || "main",
        markPrice: markPx,
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

// Известные builder-DEX'ы HL. Нужны как ФОЛБЭК: userFills весит 20 и на
// LOW-приоритете у живого бота регулярно не пролезает в бюджет (дедлайн 1.5с).
// Без фолбэка отказ выглядел бы как «на builder-DEX'ах пусто» — то есть врал бы
// ровно там, ради чего обход и написан. clearinghouseState весит 2, так что
// полный обход стоит 18 единиц против 20 у одного userFills.
export const KNOWN_BUILDER_DEXES = Object.freeze([
  "xyz", "flx", "vntl", "hyna", "km", "abcd", "cash", "para", "mkts",
]);

/**
 * @param {string} address
 * @param {{ fallbackDexes?: string[] }} [opts] — какие площадки обойти, если
 *   список из userFills не удалось получить. По умолчанию только основной DEX.
 */
export async function fetchPositions(address, opts = {}) {
  // Список DEX'ов не обязателен: если userFills не дождался бюджета, идём по
  // фолбэку (или показываем хотя бы основной счёт), пометив partial.
  let dexes = [""];
  let partial = false;
  try {
    dexes = await dexesFor(address);
  } catch {
    partial = true;
    if (opts.fallbackDexes?.length) dexes = ["", ...opts.fallbackDexes];
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
  // Время открытия — из кэша филлов. Ключ там ровно тот же, что в позиции:
  // биржа отдаёт монету builder-DEX'а уже с префиксом площадки («xyz:GOLD»).
  const opened = openedAtFor(address);
  for (const p of positions) {
    const ts = opened.get(p.coin);
    p.entryTime = Number.isFinite(ts) ? ts : null;
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


