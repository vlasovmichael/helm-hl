// Витрина OI. Этот роут убивал бота: на каждый запрос он материализовал в куче
// два месячных JSONL целиком (~53МБ текста → ~830 тысяч объектов), давая залп
// +175МБ поверх рабочих 190МБ — отсюда FATAL heap limit и «сам перезагрузился»
// (см. memory container_oom_silent_restart_2026_08_02). Здесь проверяется то,
// что удерживает новую реализацию от отката к чтению всего файла: хвост вместо
// файла, построчный проход вместо материализации, честная подпись охвата.
//
// Запуск: npm test

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = await mkdtemp(join(tmpdir(), 'oi-collector-'));
process.env.OI_COLLECTOR_DIR = dir;

const {
  handleOiOverview, handleOiCoin, lineTime, downsample, buildOverview, _resetOiCaches,
} = await import('../src/modules/dashboard/routes/oiCollector.js');

const HOUR = 3600_000;
const now = Date.now();

/** Снимок в формате коллектора: {"t":…,"n":…,"d":{COIN:{oi,f,px,v}}} */
const snap = (t, d) => JSON.stringify({ t, n: Object.keys(d).length, d });

/** Фейковый res: собирает json-ответ. */
function fakeRes() {
  return {
    body: null,
    code: 200,
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);

async function writeMonth(ms, lines) {
  await writeFile(join(dir, `oi-${monthOf(ms)}.jsonl`), lines.join('\n') + '\n');
}

before(async () => {
  // 30 часов истории с шагом в час: хватает и на Δ24ч, и на Δ1ч.
  const lines = [];
  for (let h = 30; h >= 0; h--) {
    const t = now - h * HOUR;
    lines.push(snap(t, {
      BTC: { oi: 1000 + h, f: 0.00001, px: 100 - h, v: 5e9 },
      ETH: { oi: 500, f: 0.00002, px: 20, v: 1e9 },
    }));
  }
  await writeMonth(now, lines);
});

after(async () => { await rm(dir, { recursive: true, force: true }); });

beforeEach(() => { _resetOiCaches(); });

test('lineTime достаёт t без разбора всей строки, мусор даёт null', () => {
  assert.equal(lineTime('{"t":1787777103068,"n":232,"d":{}}'), 1787777103068);
  assert.equal(lineTime('не json'), null);
  assert.equal(lineTime(''), null);
});

test('overview: последний снимок + Δ24ч и Δ1ч по каждой монете', async () => {
  const res = fakeRes();
  await handleOiOverview({}, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.has24h, true);
  assert.equal(res.body.has1h, true);

  const btc = res.body.coins.find((c) => c.coin === 'BTC');
  // oi шёл 1030 → 1000 (h=0), сутки назад было 1024, час назад 1001.
  assert.equal(btc.oi, 1000);
  assert.ok(Math.abs(btc.dOi24hPct - ((1000 - 1024) / 1024) * 100) < 1e-9);
  assert.ok(Math.abs(btc.dOi1hPct - ((1000 - 1001) / 1001) * 100) < 1e-9);
});

test('overview: сортировка по oiUsd, монета без цены выпадает', async () => {
  const res = fakeRes();
  await handleOiOverview({}, res);
  const usd = res.body.coins.map((c) => c.oiUsd);
  assert.deepEqual([...usd].sort((a, b) => b - a), usd);
});

test('overview: подпись охвата считает ВСЮ историю, а не прочитанный хвост', async () => {
  const res = fakeRes();
  await handleOiOverview({}, res);
  // 31 снимок в файле, хотя для Δ24ч читается только хвост.
  assert.equal(res.body.span.count, 31);
  assert.ok(res.body.span.firstT <= now - 30 * HOUR + 1);
});

test('coin: ряд по одной монете, отсечка по hours', async () => {
  const res = fakeRes();
  await handleOiCoin({ query: { coin: 'BTC', hours: 5 } }, res);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.rawCount, 5); // граница cutoff подвижна: t = now-4h … now
  assert.ok(res.body.points.every((p) => p.t >= now - 5 * HOUR - 1));
  assert.ok(res.body.points.every((p) => p.oiUsd === p.oi * p.px));
});

test('coin: без имени — 400, неизвестная монета — честный отказ', async () => {
  const r1 = fakeRes();
  await handleOiCoin({ query: {} }, r1);
  assert.equal(r1.code, 400);

  const r2 = fakeRes();
  await handleOiCoin({ query: { coin: 'НЕТТАКОЙ' } }, r2);
  assert.equal(r2.body.ok, false);
  assert.equal(r2.body.reason, 'no-coin-data');
});

test('downsample: режет до предела и всегда сохраняет последнюю точку', () => {
  const raw = Array.from({ length: 500 }, (_, i) => ({ t: i }));
  const out = downsample(raw, 180);
  assert.ok(out.length <= 181);
  assert.equal(out[out.length - 1], raw[raw.length - 1]);
  assert.deepEqual(downsample(raw.slice(0, 10), 180), raw.slice(0, 10));
});

test('buildOverview: без снимка сутками ранее Δ24ч = null, а витрина живёт', () => {
  const rows = [{ t: now, d: { BTC: { oi: 10, px: 2, f: 0, v: 0 } } }];
  const out = buildOverview(rows, { count: 1, firstT: now });
  assert.equal(out.ok, true);
  assert.equal(out.has24h, false);
  assert.equal(out.coins[0].dOi24hPct, null);
  assert.equal(out.coins[0].oiUsd, 20);
});

test('граница месяца: чтение продолжается в предыдущий месячный файл', async () => {
  // Хвост текущего месяца границу не накрывает — значит нужно идти в прошлый
  // файл. 1-го числа именно так и лежит снимок «сутки назад».
  const dir2 = await mkdtemp(join(tmpdir(), 'oi-boundary-'));
  process.env.OI_COLLECTOR_DIR = dir2;
  const mod = await import('../src/modules/dashboard/routes/oiCollector.js?boundary=1');

  const prevMs = now - 40 * 24 * HOUR;
  await writeFile(join(dir2, `oi-${monthOf(now)}.jsonl`),
    snap(now, { BTC: { oi: 900, f: 0, px: 50, v: 1 } }) + '\n');
  await writeFile(join(dir2, `oi-${monthOf(prevMs)}.jsonl`),
    snap(prevMs, { BTC: { oi: 1000, f: 0, px: 40, v: 1 } }) + '\n');

  const rows = await mod.snapshotsSince(now - 45 * 24 * HOUR);
  assert.deepEqual(rows.map((r) => r.t), [prevMs, now], 'оба файла должны попасть в выборку');

  // А когда граница накрыта хвостом текущего месяца — прошлый файл не читаем.
  const near = await mod.snapshotsSince(now - HOUR);
  assert.deepEqual(near.map((r) => r.t), [now]);

  process.env.OI_COLLECTOR_DIR = dir;
  await rm(dir2, { recursive: true, force: true });
});
