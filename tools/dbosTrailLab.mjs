// ─────────────────────────────────────────────────
//  DBOS lab: переживёт ли пик трейла убийство процесса без стора
// ─────────────────────────────────────────────────
//
// Шаг 1 плана durable execution (docs/dbos-durable-plan.md).
//
// Замеряемое утверждение: в durable-воркфлоу пик и взвод BE — обычные локальные
// переменные, и они переживают kill -9 без единой строчки персиста. Сегодня за
// это отвечает src/modules/adoptTrailStore.js; здесь такого файла нет.
//
// Как читать результат: журнал побочных эффектов (data/dbos-lab/effects.log)
// пишется ТОЛЬКО из реально выполнившегося тела шага. Если шаг восстановлен из
// чекпоинта, строки не появится. Ровно это и есть замер, а не логи в консоли:
// тело воркфлоу при восстановлении переигрывается целиком, и консоль врёт.
//
//   npm i --no-save @dbos-inc/dbos-sdk embedded-postgres
//   node tools/dbosPgUp.mjs                       # терминал 1
//   node tools/dbosTrailLab.mjs reset             # терминал 2
//   node tools/dbosTrailLab.mjs run --crash-at 4  #   умирает на 4-м тике
//   node tools/dbosTrailLab.mjs steps             #   чекпоинты в Postgres
//   node tools/dbosTrailLab.mjs run               #   продолжает с того же места

import { DBOS } from '@dbos-inc/dbos-sdk';
import { appendFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const WF_ID = 'adopt-demo-HYPE';
const LAB_DIR = resolve(join('data', 'dbos-lab'));
const EFFECTS = join(LAB_DIR, 'effects.log');
const DB_URL = 'postgres://lab:lab@localhost:5433/dbos_lab';

const effect = (line) => {
  mkdirSync(LAB_DIR, { recursive: true });
  appendFileSync(EFFECTS, `${new Date().toISOString()} ${line}\n`);
};

// Цены зашиты, чтобы прогон был воспроизводимым: проверяем механику durable, а
// не рынок. Пик приходится на тик 5 — уже ПОСЛЕ точки падения.
const PRICES = [100, 103, 107, 111, 118, 126, 121, 114, 108];

const crashAt = (() => {
  const i = process.argv.indexOf('--crash-at');
  return i === -1 ? -1 : Number(process.argv[i + 1]);
})();

async function armStop(coin, entry) {
  effect(`ARM   ${coin} стоп ${(entry * 0.99).toFixed(2)}`);
  return Number((entry * 0.99).toFixed(2));
}

async function readPrice(i) {
  effect(`TICK  ${i} цена ${PRICES[i]}`);
  return PRICES[i];
}

async function closeTrade(coin, peak, stop) {
  effect(`CLOSE ${coin} по ${stop} (пик был ${peak})`);
  return { coin, peak, stop };
}

async function superviseFn(coin, entry) {
  const initialStop = await DBOS.runStep(() => armStop(coin, entry), { name: 'armStop' });

  // Вот оно, главное: peak и stop — обычные переменные внутри воркфлоу.
  let peak = entry;
  let stop = initialStop;

  for (let i = 0; i < PRICES.length; i++) {
    const price = await DBOS.runStep(() => readPrice(i), { name: `tick-${i}` });

    if (price > peak) {
      peak = price;
      stop = Number((peak * 0.95).toFixed(2)); // трейл в 5% от пика
    }

    console.log(`   тик ${i}: цена ${price} | пик ${peak} | стоп ${stop}`);

    if (i === crashAt) {
      console.log(`\n💥 убиваю процесс на тике ${i} (пик сейчас ${peak}) — как OOM-kill\n`);
      process.exit(137);
    }

    if (price <= stop) break;
    await DBOS.sleep(150);
  }

  return await DBOS.runStep(() => closeTrade(coin, peak, stop), { name: 'close' });
}

const supervise = DBOS.registerWorkflow(superviseFn, { name: 'superviseTrail' });

async function main() {
  const cmd = process.argv[2] ?? 'run';

  DBOS.setConfig({ name: 'adopt-lab', systemDatabaseUrl: DB_URL, logLevel: 'warn' });
  await DBOS.launch();

  if (cmd === 'reset') {
    await DBOS.deleteWorkflow(WF_ID).catch(() => {});
    rmSync(EFFECTS, { force: true });
    console.log('Лаборатория сброшена: воркфлоу и журнал эффектов удалены.');
    await DBOS.shutdown();
    return;
  }

  if (cmd === 'steps') {
    const status = await DBOS.getWorkflowStatus(WF_ID);
    console.log(`Статус воркфлоу ${WF_ID}: ${status?.status ?? 'нет такого'}`);
    for (const s of (await DBOS.listWorkflowSteps(WF_ID)) ?? []) {
      const out = s.output == null ? '' : ` → ${JSON.stringify(s.output)}`;
      console.log(`  #${s.functionID} ${s.name}${out}`);
    }
    await DBOS.shutdown();
    return;
  }

  const before = await DBOS.getWorkflowStatus(WF_ID);
  console.log(before ? `Продолжаю воркфлоу (было: ${before.status})\n` : 'Новый воркфлоу\n');

  // Незавершённый воркфлоу нельзя запускать заново — его поднимают с чекпоинта.
  const handle = before && before.status !== 'SUCCESS' && before.status !== 'ERROR'
    ? await DBOS.resumeWorkflow(WF_ID)
    : await DBOS.startWorkflow(supervise, { workflowID: WF_ID })('HYPE', 100);

  console.log(`\n✅ завершено: ${JSON.stringify(await handle.getResult())}`);

  const lines = existsSync(EFFECTS) ? readFileSync(EFFECTS, 'utf8').trimEnd().split('\n') : [];
  console.log(`\nЖурнал побочных эффектов (${lines.length} строк за всё время):`);
  for (const l of lines) console.log('  ' + l.slice(11));

  await DBOS.shutdown();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
