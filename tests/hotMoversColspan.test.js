// Подстрока активной позиции обязана покрывать ВСЕ колонки Hot Movers: при
// меньшем colspan справа оставался белый хвост, и полоса позиции обрывалась
// на середине таблицы.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync("src/modules/dashboard/web/index.html", "utf8");
const activeCoins = readFileSync("src/modules/dashboard/web/src/state/activeCoins.js", "utf8");
const render = readFileSync("src/modules/dashboard/web/src/hotMovers/render.js", "utf8");

/** Число <th> в шапке таблицы Hot Movers. */
function hotMoverColumns() {
  const table = html.slice(html.indexOf("hm-table"));
  const head = table.slice(table.indexOf("<thead>"), table.indexOf("</thead>"));
  return (head.match(/<th[\s>]/g) || []).length;
}

test("подстрока активной позиции покрывает все колонки Hot Movers", () => {
  const cols = hotMoverColumns();
  assert.ok(cols > 0, "шапка Hot Movers не найдена");
  const m = activeCoins.match(/<td colspan="(\d+)"/);
  assert.ok(m, "в activeCoins.js нет <td colspan>");
  assert.equal(Number(m[1]), cols);
});

test("служебные строки Hot Movers тоже во всю ширину", () => {
  const cols = hotMoverColumns();
  for (const m of render.matchAll(/<td colspan="(\d+)"/g)) {
    assert.equal(Number(m[1]), cols, `colspan ${m[1]} не равен числу колонок ${cols}`);
  }
});
