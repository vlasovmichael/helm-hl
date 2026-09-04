// Во что окрашивать пуш: цвет означает ИСХОД, а не тип события.

import test from "node:test";
import assert from "node:assert/strict";

import { classifyNotif } from "../src/modules/dashboard/web/src/features/notifyTone.js";

const kind = (title, message, tags = [], priority = 3) =>
  classifyNotif({ title, message, tags, priority }).kind;

test("закрытие в плюс — ok, даже если причина выхода «stop»", () => {
  assert.equal(
    kind("LONG #SOL closed", "PnL +$3.10 · held 2h · trail-stop", ["white_check_mark"], 3),
    "ok",
  );
});

test("закрытие в минус — loss, а не общая тревога", () => {
  assert.equal(
    kind("SHORT #WIF closed", "PnL −$1.40 · held 20m · stop", ["rotating_light"], 4),
    "loss",
  );
});

test("вход нейтрален: исхода у него ещё нет", () => {
  assert.equal(
    kind("LONG #BTC opened", "size $40.00 · entry $104220", ["green_circle"], 2),
    "info",
  );
});

test("авария — danger", () => {
  assert.equal(
    kind("Circuit breaker tripped", "3 losses in a row · entries locked", ["rotating_light"], 5),
    "danger",
  );
  assert.equal(kind("⚠️ Внешнее закрытие #HYPE", "позиции нет на бирже"), "danger");
});

test("режимные предупреждения — warn", () => {
  assert.equal(kind("Breadth flush", "62% монет валятся · risk-off", ["snowflake"], 3), "warn");
});

test("иконка у закрытия зависит от знака, а не от тегов", () => {
  const win = classifyNotif({ title: "#SOL closed", message: "PnL +$1.00", tags: [] });
  const loss = classifyNotif({ title: "#SOL closed", message: "PnL −$1.00", tags: [] });
  assert.equal(win.glyph, "check");
  assert.equal(loss.glyph, "falling");
  assert.notEqual(win.cls, loss.cls);
});
