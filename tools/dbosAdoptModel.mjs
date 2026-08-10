// ─────────────────────────────────────────────────
//  DBOS lab, шаг 2: жизненный цикл adopt-позы как durable-воркфлоу
// ─────────────────────────────────────────────────
//
// План: docs/dbos-durable-plan.md. Шаг 1 (tools/dbosTrailLab.mjs) показал, что
// пик переживает kill. Здесь — модель настоящей няньки, а не миниатюра, и
// главный вопрос уже другой: что будет с воркфлоу, который живёт СУТКАМИ на
// 2-секундной петле.
//
// Что моделируется по-настоящему:
//   • те же пороги, что у живой няньки (ADOPT_BE_ARM_PCT и т.д., те же дефолты)
//   • то же состояние: peak / trough / beArmed — ровно тройка из strategistAdopt
//   • те же два мягких выхода: BE-храповик и трейл от пика
//   • жёсткий стоп НЕ дублируется: он лежит на бирже resting-ордером
//
// Чего здесь намеренно НЕТ: решение о выходе не переписано. Логика выхода —
// чистая функция от (состояние, цена), и она одна и та же в проде и здесь.
// Спорный элемент — только то, ГДЕ живёт состояние, его и меряем.
//
//   npm i --no-save @dbos-inc/dbos-sdk embedded-postgres
//   node tools/dbosPgUp.mjs                                  # терминал 1
//   node tools/dbosAdoptModel.mjs run --crash-at 300         # умереть на 300-м тике
//   node tools/dbosAdoptModel.mjs run                        # продолжить
//   node tools/dbosAdoptModel.mjs replay-cost                # цена восстановления
//   node tools/dbosAdoptModel.mjs reset

import { DBOS } from '@dbos-inc/dbos-sdk';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LAB_DIR = resolve(join('data', 'dbos-lab'));
const EVENTS = join(LAB_DIR, 'adopt-model.log');
const DB_URL = 'postgres://lab:lab@localhost:5433/dbos_lab';

// Те же пороги и те же дефолты, что читает src/core/config.js. Читаем env
// напрямую, чтобы не тащить в лабораторию валидацию всего конфига бота.
const BE_ARM = parseFloat(process.env.ADOPT_BE_ARM_PCT || '1.5');
const BE_FLOOR = parseFloat(process.env.ADOPT_BE_FLOOR_PCT || '0');
const TRAIL_ARM = parseFloat(process.env.ADOPT_TRAIL_ARM_PCT || '2');
const TRAIL_GB = parseFloat(process.env.ADOPT_TRAIL_GIVE_BACK_PCT || '30');

// Поколение = сколько тиков живёт один воркфлоу, прежде чем передать состояние
// следующему. Смысл числа — в разделе «continue-as-new» ниже.
const GEN_TICKS = Number(process.env.LAB_GEN_TICKS || 500);
const TICK_MS = Number(process.env.LAB_TICK_MS || 2); // в проде 2000

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? dflt : Number(process.argv[i + 1]);
};

const log = (line) => {
  mkdirSync(LAB_DIR, { recursive: true });
  appendFileSync(EVENTS, `${new Date().toISOString()} ${line}\n`);
};

// ── Позиция и цены ────────────────────────────────────────────────────────
// Синтетический ряд: детерминированный, чтобы прогон повторялся. Форма важна —
// сначала уводит в плюс выше порогов (взводит BE и трейл), потом разворот.
const POSITION = { id: 4242, coin: 'HYPE', side: 'long', entry_price: 100 };

function priceAt(i) {
  const drift = Math.min(i / 120, 3.4); // до +3.4% за ~первые 400 тиков
  const wave = Math.sin(i / 37) * 0.35;
  const turn = i > 620 ? -((i - 620) / 90) : 0; // разворот: трейл должен сработать
  return Number((POSITION.entry_price * (1 + (drift + wave + turn) / 100)).toFixed(4));
}

// ── Чистая логика выхода: копия контракта strategistAdopt.analyzeAdopt ────
// Единственная разница с продом — состояние приходит аргументом, а не лежит в
// приватных Map модуля. Это и есть предмет эксперимента.
function decideAdopt(state, price) {
  const isShort = POSITION.side === 'short';
  const entry = POSITION.entry_price;
  const u = isShort ? ((entry - price) / entry) * 100 : ((price - entry) / entry) * 100;

  const next = { ...state };
  if (u > next.peak) next.peak = u;
  if (u < next.trough) next.trough = u;

  if (next.peak >= TRAIL_ARM && u > 0) {
    const giveBack = next.peak - u;
    if (giveBack >= next.peak * (TRAIL_GB / 100)) {
      return [next, { action: 'CLOSE', reason: 'adopt_trail_tp', peakPct: next.peak, price }];
    }
  }

  if (next.peak >= BE_ARM) next.beArmed = true;
  if (next.beArmed && u <= BE_FLOOR) {
    return [next, { action: 'CLOSE', reason: 'adopt_breakeven_ratchet', peakPct: next.peak, price }];
  }

  return [next, { action: 'HOLD' }];
}

// ── Шаги (то, что имеет побочный эффект или недетерминировано) ────────────
async function readPrice(i) {
  return priceAt(i);
}

async function closePosition(sig) {
  // В проде здесь execute() — единственное место, где воркфлоу трогает деньги.
  // Шаг даёт «хотя бы один раз», поэтому в бою тут обязателен client order id
  // (см. docs/dbos-durable-plan.md, «Идемпотентность»).
  log(`CLOSE ${POSITION.coin} ${sig.reason} по ${sig.price} (пик +${sig.peakPct.toFixed(2)}%)`);
  return { closed: true, reason: sig.reason, peakPct: sig.peakPct, price: sig.price };
}

// ── Воркфлоу одного поколения ─────────────────────────────────────────────
async function generationFn(gen, carry) {
  const crashAt = arg('--crash-at', -1);
  let state = carry.state;

  for (let n = 0; n < GEN_TICKS; n++) {
    const i = carry.tick0 + n;
    const price = await DBOS.runStep(() => readPrice(i), { name: `px-${i}` });

    const [next, sig] = decideAdopt(state, price);
    state = next;

    if (i === crashAt) {
      console.log(`\n💥 убиваю на тике ${i}: пик +${state.peak.toFixed(2)}%, beArmed=${state.beArmed}\n`);
      process.exit(137);
    }

    if (sig.action === 'CLOSE') {
      const res = await DBOS.runStep(() => closePosition(sig), { name: 'close' });
      console.log(`✅ закрыто на тике ${i}: ${res.reason}, пик +${res.peakPct.toFixed(2)}%`);
      return { ...res, ticks: i + 1, generations: gen + 1 };
    }

    await DBOS.sleep(TICK_MS);
  }

  // continue-as-new. Без этого история шагов растёт вместе с возрастом позы, а
  // вместе с ней — время восстановления после падения (замер: replay-cost).
  // Поколение обрывает историю, перенося ровно то, что нужно дальше: тройку
  // состояния и номер тика.
  const nextGen = gen + 1;
  const handle = await DBOS.startWorkflow(generation, { workflowID: wfId(nextGen) })(nextGen, {
    state,
    tick0: carry.tick0 + GEN_TICKS,
  });
  console.log(`   ↻ поколение ${gen} → ${nextGen} (пик +${state.peak.toFixed(2)}%, beArmed=${state.beArmed})`);
  return await handle.getResult();
}

const generation = DBOS.registerWorkflow(generationFn, { name: 'adoptGeneration' });
const wfId = (gen) => `adopt-${POSITION.id}-g${gen}`;

// Зонд для замера цены восстановления. Регистрация обязана быть до launch().
// Первый прогон набирает k шагов и убивает процесс; второй — переигрывает их и
// доделывает последний шаг.
const probe = DBOS.registerWorkflow(
  async function probeFn(k, dieAtEnd) {
    for (let i = 0; i < k; i++) await DBOS.runStep(() => readPrice(i), { name: `px-${i}` });
    if (dieAtEnd) process.exit(137);
    return await DBOS.runStep(() => readPrice(k), { name: 'tail' });
  },
  { name: 'replayProbe' },
);

// ── Команды ───────────────────────────────────────────────────────────────
async function findLiveGeneration() {
  // Живым считаем самое старшее поколение, которое ещё не завершилось успехом.
  for (let gen = 0; gen < 200; gen++) {
    const st = await DBOS.getWorkflowStatus(wfId(gen));
    if (!st) return gen === 0 ? null : null;
    if (st.status !== 'SUCCESS' && st.status !== 'ERROR') return { gen, status: st.status };
  }
  return null;
}

async function cmdRun() {
  const live = await findLiveGeneration();
  let handle;
  if (live) {
    console.log(`Продолжаю поколение ${live.gen} (было: ${live.status})\n`);
    handle = await DBOS.resumeWorkflow(wfId(live.gen));
  } else {
    console.log('Новая поза, поколение 0\n');
    handle = await DBOS.startWorkflow(generation, { workflowID: wfId(0) })(0, {
      state: { peak: 0, trough: 0, beArmed: false },
      tick0: 0,
    });
  }
  const res = await handle.getResult();
  console.log(`\nИтог: ${JSON.stringify(res)}`);
}

async function cmdProbe() {
  // Половинка замера: набрать K шагов и умереть, либо подняться и доделать.
  const K = arg('--steps', 100);
  const id = `probe-${K}`;
  const dying = process.argv.includes('--crash');

  if (dying) {
    await DBOS.deleteWorkflow(id).catch(() => {});
    await DBOS.startWorkflow(probe, { workflowID: id })(K, true);
    // startWorkflow вернулся — воркфлоу уже убил процесс изнутри.
    return;
  }
  const st = await DBOS.getWorkflowStatus(id);
  if (!st) return;
  await (await DBOS.resumeWorkflow(id)).getResult();
}

async function cmdReplayCost() {
  // Сколько стоит поднять воркфлоу, у которого за спиной K шагов.
  //
  // forkWorkflow для этого не годится: он копирует строки в базе, а тело не
  // переигрывает. Меряем то, что происходит в жизни: процесс умирает на K-м
  // шаге, второй процесс поднимает воркфлоу и доделывает один оставшийся шаг.
  // Из времени вычитаем базовую линию K=0 — это старт ноды и launch DBOS.
  const { execFileSync } = await import('node:child_process');
  const self = new URL(import.meta.url).pathname;
  const run = (args) => {
    // Умирающий прогон выходит со 137 — для execFileSync это «ошибка», для нас норма.
    try { execFileSync(process.execPath, [self, ...args], { stdio: 'ignore' }); } catch { /* ожидаемо */ }
  };
  const measure = (K) => {
    run(['probe', '--steps', String(K), '--crash']);
    const t = Date.now();
    run(['probe', '--steps', String(K)]);
    return Date.now() - t;
  };

  // Шум процессного старта — десятки мс, поэтому каждый замер трижды, берём
  // медиану. Иначе разница между 100 и 5000 шагами утонет в дрожании.
  const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const measure3 = (K) => median([measure(K), measure(K), measure(K)]);

  const base = measure3(0);
  console.log(`базовая линия (старт ноды + launch DBOS, медиана из 3): ${base} мс`);
  console.log('шагов в истории → чистая переигровка (медиана из 3)');
  for (const K of [100, 1000, 5000]) {
    console.log(`  ${String(K).padStart(5)} → ${String(measure3(K) - base).padStart(5)} мс`);
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'run';
  DBOS.setConfig({ name: 'adopt-model', systemDatabaseUrl: DB_URL, logLevel: 'warn' });
  await DBOS.launch();

  if (cmd === 'reset') {
    for (let gen = 0; gen < 200; gen++) await DBOS.deleteWorkflow(wfId(gen)).catch(() => {});
    rmSync(EVENTS, { force: true });
    console.log('Модель сброшена.');
  } else if (cmd === 'replay-cost') {
    await cmdReplayCost();
  } else if (cmd === 'probe') {
    await cmdProbe();
  } else {
    await cmdRun();
  }

  await DBOS.shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
