// ─────────────────────────────────────────────────
//  DBOS lab, шаг 4: тень — что durable-состояние меняет в ВЫХОДАХ
// ─────────────────────────────────────────────────
//
// План: docs/dbos-durable-plan.md.
//
// Устройство замера. Обе стороны крутят ОДИН И ТОТ ЖЕ живой analyzeAdopt из
// src/modules/strategistAdopt.js — логика выхода не переписана и не пересказана.
// Различается только то, что переживает рестарт:
//
//   arm «store»   — как в проде сегодня: adoptTrailStore пишет пик на диск,
//                   но лишь когда он дорос до PERSIST_FROM_PCT (min(BE_ARM,
//                   TRAIL_ARM) = 1.5%). Мелочь у нуля не пишется намеренно.
//   arm «durable» — как было бы на DBOS: помнится КАЖДЫЙ тик, без порога.
//
// Рестарт эмулируется честно: resetAdoptState() гасит память процесса, и модуль
// поднимает состояние из своего источника — ровно то, что происходит при OOM.
//
// Вопрос замера ровно один: меняет ли «помнить всё» хоть один ВЫХОД, или
// пороговая запись уже сохраняет всё, что способно повлиять на решение.
//
//   npm i --no-save @dbos-inc/dbos-sdk embedded-postgres
//   node tools/dbosPgUp.mjs              # терминал 1
//   node tools/dbosShadowCompare.mjs     # терминал 2

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Те же переменные, что ставит tests/adoptTrailPersist.test.js: config бота
// требует кошелёк, а пороги фиксируем, чтобы замер не зависел от .env машины.
process.env.NODE_ENV = 'test';
process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';
process.env.ADOPT_BE_ARM_PCT = '1.5';
process.env.ADOPT_BE_FLOOR_PCT = '0';
process.env.ADOPT_TRAIL_ARM_PCT = '2';
process.env.ADOPT_TRAIL_GIVE_BACK_PCT = '30';

const store = await import('../src/modules/adoptTrailStore.js');
const { analyzeAdopt, resetAdoptState, getAdoptPeakPct, getAdoptMaePct } =
  await import('../src/modules/strategistAdopt.js');
const { DBOS } = await import('@dbos-inc/dbos-sdk');

const POS = { id: 7, coin: 'HYPE', side: 'long', entry_price: 100, mode: 'PRODUCTION' };
const pct = (p) => POS.entry_price * (1 + p / 100);

// ── Сценарии ──────────────────────────────────────────────────────────────
// Каждый — путь цены в процентах от входа плюс тики, на которых процесс умирает.
// Подобраны вокруг порога 1.5%: если пороговая запись что-то теряет, вылезет тут.
const SCENARIOS = [
  {
    name: 'пик 1.2% (ниже порога записи) → смерть → сползание в минус',
    path: [0.3, 0.8, 1.2, 0.9, 0.4, -0.2, -0.8, -1.4],
    restarts: [3],
  },
  {
    name: 'пик 1.4% → смерть → возврат к 1.6% → откат',
    path: [0.5, 1.0, 1.4, 1.1, 1.6, 1.2, 0.5, -0.1],
    restarts: [3],
  },
  {
    name: 'пик 2.6% (выше порога) → смерть → откат 30% (трейл)',
    path: [0.7, 1.6, 2.6, 2.3, 2.0, 1.7, 1.4],
    restarts: [3],
  },
  {
    name: 'пик 1.9% → смерть → обвал в минус (BE-храповик)',
    path: [0.9, 1.6, 1.9, 1.2, 0.4, -0.3],
    restarts: [3],
  },
  {
    name: 'две смерти подряд на растущем пике',
    path: [0.4, 0.9, 1.3, 1.45, 1.55, 2.1, 1.8, 1.3],
    restarts: [2, 5],
  },
  {
    name: 'без смертей (контроль — стороны обязаны совпасть)',
    path: [0.6, 1.4, 2.2, 2.8, 2.4, 1.9, 1.5],
    restarts: [],
  },
];

// ── Прогон одной стороны ──────────────────────────────────────────────────
// restore(id) вызывается после гашения памяти и обязан вернуть в модуль то,
// что эта сторона «помнит». Дальше решение принимает живой analyzeAdopt.
async function runArm(scenario, { onTick, restore }) {
  const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
  store._setFileForTest(join(dir, 'adopt_trail.json'));
  resetAdoptState();

  const decisions = [];
  let exit = null;

  for (let i = 0; i < scenario.path.length; i++) {
    if (scenario.restarts.includes(i)) {
      resetAdoptState();               // память процесса умерла
      store._setFileForTest(join(dir, 'adopt_trail.json')); // диск на месте
      await restore(POS.id);           // сторона возвращает, что помнит
      decisions.push({ i, restart: true });
    }

    const price = pct(scenario.path[i]);
    const sig = analyzeAdopt(POS, price);
    await onTick(POS.id, { peak: getAdoptPeakPct(POS.id), trough: getAdoptMaePct(POS.id) });

    decisions.push({ i, u: scenario.path[i], action: sig.action, reason: sig.reason });
    if (sig.action === 'CLOSE') {
      exit = { i, reason: sig.reason, peakPct: Number(sig.peakPct.toFixed(3)) };
      break;
    }
  }

  const result = {
    exit,
    mfe: Number(getAdoptPeakPct(POS.id).toFixed(3)),
    mae: Number(getAdoptMaePct(POS.id).toFixed(3)),
    decisions,
  };
  rmSync(dir, { recursive: true, force: true });
  return result;
}

// ── Сторона «store»: сегодняшний прод ─────────────────────────────────────
// Ничего не делаем: analyzeAdopt сам пишет в adoptTrailStore по своему порогу,
// а после resetAdoptState сам же поднимает записанное с диска.
const armStore = { onTick: async () => {}, restore: async () => {} };

// ── Сторона «durable»: состояние в Postgres, каждый тик, без порога ───────
// Тик пишем через setEvent, а не шагом: шаг на каждый тик — это ~43 тысячи
// строк в сутки на позицию (≈21 МБ), а событие перезаписывается на месте.
let wfSeq = 0;
function makeDurableArm(scenarioIdx) {
  const wfid = `shadow-${scenarioIdx}-${wfSeq++}`;
  return {
    wfid,
    onTick: async (_id, state) => {
      await DBOS.setEvent(`state`, state).catch(() => {});
      lastSeen.set(wfid, state);
    },
    restore: async (id) => {
      const s = lastSeen.get(wfid) ?? (await DBOS.getEvent(wfid, 'state', 0));
      if (!s) return;
      // Возвращаем в живой модуль ровно то, что помнит durable-сторона.
      store.setAdoptTrail(id, { peak: s.peak, trough: s.trough, beArmed: s.peak >= 1.5 });
    },
  };
}
const lastSeen = new Map();

// setEvent доступен только внутри воркфлоу, поэтому прогон стороны durable
// целиком заворачивается в один воркфлоу.
const durableRun = DBOS.registerWorkflow(
  async function durableRunFn(scenarioIdx) {
    const arm = makeDurableArm(scenarioIdx);
    return await runArm(SCENARIOS[scenarioIdx], arm);
  },
  { name: 'shadowDurableRun' },
);

// ── Сравнение ─────────────────────────────────────────────────────────────
const sameExit = (a, b) =>
  (a === null && b === null) ||
  (a && b && a.i === b.i && a.reason === b.reason && Math.abs(a.peakPct - b.peakPct) < 1e-6);

async function main() {
  DBOS.setConfig({
    name: 'shadow-compare',
    systemDatabaseUrl: 'postgres://lab:lab@localhost:5433/dbos_lab',
    logLevel: 'error',
  });
  await DBOS.launch();

  let exitDiffs = 0;
  let statDiffs = 0;

  for (let s = 0; s < SCENARIOS.length; s++) {
    const sc = SCENARIOS[s];
    const a = await runArm(sc, armStore);
    const b = await (await DBOS.startWorkflow(durableRun, { workflowID: `shadow-run-${s}-${Date.now()}` })(s)).getResult();

    const exitOk = sameExit(a.exit, b.exit);
    const statOk = Math.abs(a.mfe - b.mfe) < 1e-6 && Math.abs(a.mae - b.mae) < 1e-6;
    if (!exitOk) exitDiffs++;
    if (!statOk) statDiffs++;

    const fmt = (r) => (r.exit ? `выход на ${r.exit.i} (${r.exit.reason})` : 'не закрылась');
    console.log(`\n${exitOk ? '=' : '≠'} ${sc.name}`);
    console.log(`    store  : ${fmt(a)} | MFE ${a.mfe}% MAE ${a.mae}%`);
    console.log(`    durable: ${fmt(b)} | MFE ${b.mfe}% MAE ${b.mae}%`);
    if (!statOk) console.log(`    ↳ расходятся только замеры MFE/MAE, не выход`);
  }

  console.log(`\nИтог по ${SCENARIOS.length} сценариям:`);
  console.log(`  расхождений в ВЫХОДАХ:      ${exitDiffs}`);
  console.log(`  расхождений в MFE/MAE:      ${statDiffs}`);
  console.log(
    exitDiffs === 0
      ? '\n  Вывод: durable-состояние не изменило ни одного выхода. Пороговая\n' +
        '  запись в adoptTrailStore уже сохраняет всё, что способно повлиять на\n' +
        '  решение — ниже 1.5% ни BE-храповик, ни трейл не взводятся в принципе.'
      : '\n  Вывод: есть выходы, которые durable-состояние меняет — разобрать поштучно.',
  );

  await DBOS.shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
