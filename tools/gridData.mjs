// ─────────────────────────────────────────────────
//  gridData — свечи всей вселенной HL под сеточный поиск эджа
// ─────────────────────────────────────────────────
// Зачем отдельно от data/borrowed/candles: тот кэш заточен под прогон чужих
// входов — хранит [t,o,h,l,c] без объёма, тянется под конкретный trips-файл и
// читается baseline.mjs, у которого формат зашит. Ломать его нельзя.
//
// Здесь нужно другое: ВСЕ монеты, один таймфрейм, с объёмом и числом сделок,
// и с накоплением истории вперёд.
//
// ── Почему бар, а не сделка ────────────────────────────────────────────────
// Мерить эдж по реализованному PnL сделок — это мерить сигнал сквозь стоп,
// трейл, комиссию и момент выхода: пять источников шума поверх одного слабого
// эффекта. Отсюда sd 2.79% на сделку и «нужно >10 000 сделок» (пересчёт 26.07).
// Условное среднее форвардной доходности на баре этих пяти слоёв не содержит:
// при sd 15-минутной доходности ~0.8% эффект в 5 бп ловится примерно на 2000
// срабатываниях. Тот же вопрос, на порядок меньше требуемых наблюдений.
//
// ── Жёсткое ограничение, которое не обойти ─────────────────────────────────
// 🚨 HL отдаёт максимум ~5000 баров на интервал. На 15m это 52 дня, и БОЛЬШЕ
// НЕ БУДЕТ: то, что старше, у биржи просто не хранится. Единственный способ
// иметь длинную историю — сшивать снимки, поэтому файл здесь append-only по
// времени: новый прогон дописывает свежий хвост, а старое НЕ выбрасывает.
// Практический вывод: чем раньше это начнёт крутиться регулярно, тем длиннее
// окно будет через полгода. Сегодня — 52 дня.
//
// ⚠️ 52 дня — это, скорее всего, ОДИН режим рынка. Любая находка на таком окне
// не может получить статус «подтверждено» (harness, правило 4, выведено из
// няньки). Это не повод не копать — это повод не праздновать.
//
// ⚠️ Вес API делится с торговым путём (горели дважды: 19.07 и 31.07). Гонять
// РУКАМИ и не с хоста живого бота, либо ночью.
//
// Запуск:
//   node tools/gridData.mjs                  # 15m, вся вселенная
//   node tools/gridData.mjs --interval 5m    # короткий горизонт (17 дней)
//   node tools/gridData.mjs --limit 20       # первые 20 монет, для проверки

import { gzipSync, gunzipSync } from "node:zlib";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API = "https://api.hyperliquid.xyz/info";
const DIR = join("data", "grid", "candles");
// 🚨 ВЕСОВОЙ БЮДЖЕТ. candleSnapshot весит 20 единиц (см. WEIGHT_DEFAULT в
// src/core/hlClient.js) при лимите 1200/мин на IP ⇒ потолок 60 таких запросов
// в минуту, и это ВЕСЬ бюджет, включая торговый путь. Полный проход — ~350
// запросов, поэтому на живой машине пауза обязана быть секундной, а не 220 мс:
// при 220 мс проход съедает ~5400 веса в минуту, то есть в 4.5 раза больше
// лимита. Именно так вставал тик 31.07 и голодал пул 19.07.
//   5000 мс → 12 запросов/мин × 20 = 240 веса = 20% бюджета. Проход ~30 минут.
// Дефолт оставлен быстрым для ручных прогонов с ноутбука (другой IP).
const PAUSE_MS = Number(process.env.GRID_PAUSE_MS || 220);
const CHUNK = 5000;

const IV_MS = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1h": 3_600_000 };

const args = process.argv.slice(2);
const argVal = (name, dflt) => {
  const i = args.indexOf(name);
  return i === -1 ? dflt : args[i + 1];
};
const INTERVAL = argVal("--interval", "15m");
const LIMIT = Number(argVal("--limit", 0)) || 0;
const BAR_MS = IV_MS[INTERVAL];
if (!BAR_MS) { console.error(`неизвестный интервал ${INTERVAL}`); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(body, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(25_000),
      });
      if (res.status === 429) { await sleep(2500 * (i + 1)); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(800 * (i + 1));
    }
  }
  return null;
}

/** Список перпов HL. Берём из meta, а не из своего watchlist: сетка должна
 *  видеть весь рынок, иначе «отбор монеты» уже сделан за нас. */
async function universe() {
  const meta = await post({ type: "meta" });
  const names = (meta?.universe || [])
    .filter((u) => !u.isDelisted)
    .map((u) => u.name);
  return names;
}

function pathFor(coin) {
  return join(DIR, `${coin.replace(/[^A-Za-z0-9_-]/g, "_")}.${INTERVAL}.json.gz`);
}

function loadLocal(coin) {
  const p = pathFor(coin);
  if (!existsSync(p)) return null;
  try { return JSON.parse(gunzipSync(readFileSync(p)).toString()); } catch { return null; }
}

/**
 * Тянет максимум доступной истории и СШИВАЕТ с тем, что уже лежит.
 * rows: [t, o, h, l, c, v, n] — объём и число сделок сохраняются, в отличие от
 * borrowed-кэша: объёмный шок это отдельное семейство признаков, и выбросить
 * его на этапе загрузки значит закрыть его навсегда.
 */
async function fetchCoin(coin) {
  const now = Date.now();
  const wantFrom = now - CHUNK * BAR_MS;
  const fresh = [];
  let cursor = wantFrom;
  for (let guard = 0; guard < 40 && cursor < now; guard++) {
    const stop = Math.min(now, cursor + CHUNK * BAR_MS);
    const r = await post({
      type: "candleSnapshot",
      req: { coin, interval: INTERVAL, startTime: cursor, endTime: stop },
    });
    await sleep(PAUSE_MS);
    if (!Array.isArray(r) || !r.length) { cursor = stop; continue; }
    for (const c of r) fresh.push([c.t, +c.o, +c.h, +c.l, +c.c, +c.v, +c.n]);
    const last = r[r.length - 1].t;
    cursor = last <= cursor ? stop : last + BAR_MS;
  }
  if (!fresh.length) return null;

  // Сшивка: старые бары НЕ выбрасываем, даже если биржа их уже забыла.
  const prev = loadLocal(coin);
  const merged = new Map();
  for (const row of prev?.rows || []) merged.set(row[0], row);
  for (const row of fresh) merged.set(row[0], row); // свежее перекрывает старое
  const rows = [...merged.values()].sort((a, b) => a[0] - b[0]);

  const payload = {
    coin,
    interval: INTERVAL,
    start: rows[0][0],
    end: rows[rows.length - 1][0],
    fields: ["t", "o", "h", "l", "c", "v", "n"],
    rows,
    updatedAt: now,
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(pathFor(coin), gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }));
  return payload;
}

/** Читает кэш монеты. Экспорт — этим пользуется gridScan. */
export function loadGridCandles(coin, interval = "15m") {
  const p = join(DIR, `${coin.replace(/[^A-Za-z0-9_-]/g, "_")}.${interval}.json.gz`);
  if (!existsSync(p)) return null;
  try { return JSON.parse(gunzipSync(readFileSync(p)).toString()); } catch { return null; }
}

/** Все монеты, по которым есть кэш на интервале. */
export function gridCoins(interval = "15m") {
  if (!existsSync(DIR)) return [];
  const suffix = `.${interval}.json.gz`;
  return readdirSync(DIR)
    .filter((f) => f.endsWith(suffix))
    .map((f) => f.slice(0, -suffix.length));
}

async function main() {
  let coins = await universe();
  if (!coins.length) { console.error("meta не отдал вселенную — сеть?"); process.exit(1); }
  if (LIMIT) coins = coins.slice(0, LIMIT);

  console.log(`вселенная HL: ${coins.length} перпов, интервал ${INTERVAL}`);
  let ok = 0, fail = 0, bars = 0, grew = 0;
  for (let i = 0; i < coins.length; i++) {
    const coin = coins[i];
    const before = loadLocal(coin)?.rows?.length || 0;
    try {
      const p = await fetchCoin(coin);
      if (p) {
        ok++; bars += p.rows.length;
        if (p.rows.length > before) grew += p.rows.length - before;
        const days = ((p.end - p.start) / 864e5).toFixed(1);
        process.stdout.write(
          `\r[${i + 1}/${coins.length}] ${coin.padEnd(12)} ${String(p.rows.length).padStart(5)} баров / ${days}д  `,
        );
      } else fail++;
    } catch (err) {
      fail++;
      console.log(`\n${coin}: ${err.message}`);
    }
  }
  console.log(
    `\n\nготово: ${ok} монет, ${bars} баров всего (+${grew} новых к прошлому снимку), ошибок ${fail}`,
  );
  console.log(`кэш: ${DIR}`);
  console.log(
    `\n⚠️  HL хранит ~5000 баров на интервал. Гоняй это регулярно — только так\n` +
    `    окно станет длиннее 52 дней, и только так появится второй режим рынка.`,
  );
}

if (process.argv[1]?.endsWith("gridData.mjs")) await main();
