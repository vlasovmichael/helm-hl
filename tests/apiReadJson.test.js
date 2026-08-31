// Разбор ответа API — то, что стоит между сбоем сервера и человеком.
//
// Запуск: npm test
//
// Что закрыто тестами (каждый пункт — способ показать оператору мусор вместо
// причины; на живых деньгах это разница между «понял» и «непонятно»):
//  - HTML вместо JSON не превращается в «Unexpected token '<'»
//  - 401 уводит на логин И прерывает выполнение (голый redirect его не прерывал)
//  - пустое тело отличается от нечитаемого
//  - нормальный JSON проходит как раньше

import { test } from "node:test";
import assert from "node:assert/strict";

import { readJson } from "../src/modules/dashboard/web/src/utils/api.js";

const res = (status, body) => ({ status, text: async () => body });

test("нормальный JSON разбирается", async () => {
  assert.deepEqual(await readJson(res(200, '{"ok":true,"price":1.5}')), { ok: true, price: 1.5 });
});

test("HTML вместо JSON даёт человеческую причину, а не имя токена", async () => {
  // Именно это висело в красной плашке модалки 31.08: страница логина
  // Cloudflare Access прилетела в парсер JSON.
  await assert.rejects(
    () => readJson(res(200, '<!DOCTYPE html><html><body>login</body></html>')),
    (err) => {
      assert.match(err.message, /page instead of data/);
      assert.match(err.message, /reload the tab/);
      assert.doesNotMatch(err.message, /Unexpected token/);
      return true;
    },
  );
});

test("401 уводит на логин И прерывает выполнение", async () => {
  // Прежний код делал `location.href = ...` и ПРОДОЛЖАЛ парсить тело —
  // редирект браузера асинхронный. Отсюда и брался мусор в ошибке.
  let redirected = 0;
  await assert.rejects(
    () => readJson(res(401, '<!DOCTYPE html>'), () => { redirected++; }),
    /session expired/,
  );
  assert.equal(redirected, 1);
});

test("пустое тело — отдельная причина, не «нечитаемое»", async () => {
  await assert.rejects(() => readJson(res(204, "")), /empty answer/);
  await assert.rejects(() => readJson(res(200, "   ")), /empty answer/);
});

test("не-HTML мусор помечается как нечитаемый ответ с кодом", async () => {
  await assert.rejects(() => readJson(res(502, "upstream boom")), /unreadable answer.*502/);
});
