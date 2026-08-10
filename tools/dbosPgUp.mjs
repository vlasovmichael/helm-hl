// ─────────────────────────────────────────────────
//  DBOS lab: портативный Postgres под лабораторию
// ─────────────────────────────────────────────────
//
// Шаг 1 плана durable execution (docs/dbos-durable-plan.md). Поднимает Postgres
// из npm-пакета: ничего не ставится в систему, прод на Oracle не трогается,
// данные лежат в data/dbos-lab/pgdata (в .gitignore).
//
// Зависимости лаборатории НАМЕРЕННО не в package.json: это эксперимент, который
// может не дожить до шага 4, а дерево зависимостей боевого бота дороже удобства.
//   npm i --no-save @dbos-inc/dbos-sdk embedded-postgres
//   node tools/dbosPgUp.mjs        # держать в отдельном терминале
//
// Остановка — Ctrl+C: пакет оставляет postgres запущенным, если его не погасить.

import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const dataDir = resolve(join('data', 'dbos-lab', 'pgdata'));
const fresh = !existsSync(dataDir);

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'lab',
  password: 'lab',
  port: 5433, // не 5432: чтобы не спорить с чем-нибудь системным
  persistent: true,
});

if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase('dbos_lab');

console.log(`[pg] готов на 5433, база dbos_lab (${fresh ? 'создана' : 'существующая'})`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
