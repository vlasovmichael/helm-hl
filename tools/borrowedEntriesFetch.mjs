// ─────────────────────────────────────────────────
//  borrowedEntriesFetch — чужие входы как сырьё для проверки МОИХ выходов
// ─────────────────────────────────────────────────
// Зачем: чтобы измерить эдж adopt-няньки, нужно >10 000 сделок. Своих столько
// накопится за годы. Но входы можно занять: фиксация утверждения «неважно как
// ты зайдёшь, эдж в няньке» — это и есть «чужие входы + мои выходы».
//
// Здесь только ДОБЫЧА и РЕКОНСТРУКЦИЯ круговых сделок. Прогон правил — в
// borrowedEntriesReplay.mjs, чтобы можно было переигрывать выходы, не дёргая
// сеть заново.
//
// ⚠️ Гоняется РУКАМИ и не с хоста живого бота: /info делит весовой пул с
// торговым путём (инцидент голодания 19.07). Пауза между запросами обязательна.
//
// Выборка адресов — механическая: полоса по месячному обороту, без единого
// взгляда на PnL. Отбор по результату сделал бы «чужие входы» выборкой
// победителей и сломал бы весь смысл замера.

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readSnapshot, listSnapshotFiles } from "./leaderboardSnapshot.mjs";

const API = "https://api.hyperliquid.xyz/info";
const OUT_DIR = join("data", "borrowed");
const PAGE_CAP = 2000; // HL отдаёт максимум столько филлов за ответ
const REQ_PAUSE_MS = 250;

// Полоса оборота: снизу отсекает пыль (пара сделок — не выборка), сверху —
// маркет-мейкеров и HFT, у которых «филл» не равен «сделке» и которые дали бы
// сотни тысяч микро-круговых, задавив собой всю выборку.
const VLM_MIN = 50_000;
const VLM_MAX = 5_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 429) {
        await sleep(2000 * (i + 1));
        continue;
      }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(500 * (i + 1));
    }
  }
  return null;
}

/** Все филлы адреса за окно, с пагинацией через потолок в 2000. */
async function fetchAllFills(user, startTime, endTime) {
  const out = [];
  let cursor = startTime;
  for (let page = 0; page < 40; page++) {
    const batch = await post({ type: "userFillsByTime", user, startTime: cursor, endTime });
    await sleep(REQ_PAUSE_MS);
    if (!Array.isArray(batch) || batch.length === 0) break;
    out.push(...batch);
    if (batch.length < PAGE_CAP) break;
    const last = Math.max(...batch.map((f) => f.time));
    if (last <= cursor) break; // защита от вечного цикла на одинаковых метках
    cursor = last + 1;
  }
  return out;
}

/**
 * Круговые сделки из филлов: позиция по (адрес, монета) от нуля до нуля.
 * Спот (`@123`) и HIP-3 (`xyz:...`) отбрасываем — у бота перп-логика.
 */
export function reconstructRoundTrips(fills, addr) {
  const byCoin = new Map();
  for (const f of fills) {
    const coin = f.coin;
    if (!coin || coin.startsWith("@") || coin.includes(":")) continue;
    if (!byCoin.has(coin)) byCoin.set(coin, []);
    byCoin.get(coin).push(f);
  }

  const trips = [];
  for (const [coin, list] of byCoin) {
    list.sort((a, b) => a.time - b.time);
    let pos = 0; // + long, − short
    let openNotional = 0;
    let openSz = 0;
    let openedAt = null;

    for (const f of list) {
      const sz = Math.abs(+f.sz);
      const px = +f.px;
      if (!(sz > 0) || !(px > 0)) continue;
      const dir = String(f.dir || "");
      // side 'B' =買 (bid/buy) увеличивает позицию вверх, 'A' = ask/sell — вниз
      const signed = f.side === "B" ? sz : -sz;
      const prev = pos;
      pos += signed;

      const opening = prev === 0 || Math.sign(prev) === Math.sign(signed);
      if (opening && Math.sign(signed) === Math.sign(pos)) {
        if (prev === 0) {
          openedAt = f.time;
          openNotional = 0;
          openSz = 0;
        }
        openNotional += sz * px;
        openSz += sz;
        continue;
      }

      // Закрытие (полное или частичное). Круговую фиксируем на возврате к нулю.
      if (Math.abs(pos) < 1e-9 && openSz > 0 && openedAt != null) {
        trips.push({
          addr,
          coin,
          side: prev > 0 ? "long" : "short",
          entryPrice: openNotional / openSz,
          entryTime: openedAt,
          exitPrice: px,
          exitTime: f.time,
          sizeUsd: openNotional,
          theirDir: dir,
        });
        pos = 0;
        openSz = 0;
        openNotional = 0;
        openedAt = null;
      } else if (Math.sign(pos) !== Math.sign(prev) && pos !== 0) {
        // Переворот через ноль: старую круговую закрываем, новую открываем.
        if (openSz > 0 && openedAt != null) {
          trips.push({
            addr,
            coin,
            side: prev > 0 ? "long" : "short",
            entryPrice: openNotional / openSz,
            entryTime: openedAt,
            exitPrice: px,
            exitTime: f.time,
            sizeUsd: openNotional,
            theirDir: dir,
          });
        }
        openedAt = f.time;
        openSz = Math.abs(pos);
        openNotional = Math.abs(pos) * px;
      }
    }
  }
  return trips;
}

/** Механическая выборка адресов из снимка лидерборда — по обороту, не по PnL. */
export function pickAddresses(limit, seed = 42) {
  const files = listSnapshotFiles();
  if (!files.length) throw new Error("нет снимков лидерборда — сначала tools/leaderboardSnapshot.mjs");
  const snap = readSnapshot(files[files.length - 1].replace(".json.gz", ""));
  const pool = snap.rows.filter((r) => r.month.vlm >= VLM_MIN && r.month.vlm <= VLM_MAX);
  // Детерминированный псевдослучайный порядок: повторный прогон = та же выборка.
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const shuffled = pool
    .map((r) => ({ r, k: rnd() }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.r);
  return { addrs: shuffled.slice(0, limit).map((r) => r.addr), poolSize: pool.length };
}

async function main() {
  const limit = parseInt(process.argv[2] || "40", 10);
  const days = parseInt(process.argv[3] || "30", 10);
  // Произвольное окно: без него нельзя взять прошлый режим рынка, а сравнение
  // «падающее vs растущее» — весь смысл замера. Даты в UTC, конец включительно.
  const startArg = process.argv[4];
  const endArg = process.argv[5];
  const tag = startArg ? `${startArg}_${endArg}` : `${days}d`;
  const outFile = join(OUT_DIR, `trips_${limit}a_${tag}.json`);
  mkdirSync(OUT_DIR, { recursive: true });

  const { addrs, poolSize } = pickAddresses(limit);
  const end = endArg ? Date.parse(`${endArg}T00:00:00Z`) : Date.now();
  const start = startArg ? Date.parse(`${startArg}T00:00:00Z`) : end - days * 864e5;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
    throw new Error(`плохое окно: ${startArg}..${endArg}`);
  }
  console.log(`окно: ${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}`);
  console.log(`пул адресов по обороту $${VLM_MIN / 1e3}k–$${VLM_MAX / 1e6}M: ${poolSize}; берём ${addrs.length}`);

  const all = [];
  let empty = 0;
  for (let i = 0; i < addrs.length; i++) {
    const fills = await fetchAllFills(addrs[i], start, end);
    const trips = reconstructRoundTrips(fills, addrs[i]);
    if (!trips.length) empty++;
    all.push(...trips);
    if ((i + 1) % 25 === 0 || i === addrs.length - 1) {
      // Чекпоинт: часовой прогон не должен пропадать целиком от одного обрыва.
      writeFileSync(outFile, JSON.stringify({ capturedAt: end, days, addrs: i + 1, trips: all }));
      console.log(`[${i + 1}/${addrs.length}] круговых всего: ${all.length} (чекпоинт)`);
    }
  }

  writeFileSync(outFile, JSON.stringify({ capturedAt: end, days, addrs: addrs.length, trips: all }));
  const coins = new Set(all.map((t) => t.coin));
  console.log(`сохранено ${all.length} круговых, ${coins.size} монет, пустых адресов ${empty} → ${outFile}`);
}

if (process.argv[1]?.endsWith("borrowedEntriesFetch.mjs")) await main();
