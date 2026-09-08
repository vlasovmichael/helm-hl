// Во что окрашивать пуш: цвет означает ИСХОД, а не тип события.

import test from "node:test";
import assert from "node:assert/strict";

import { classifyNotif, toastDir } from "../src/modules/dashboard/web/src/features/notifyTone.js";

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

test("радар OI информационный, даже когда в тексте «flushed»", () => {
  const r = classifyNotif({
    title: "OI #PONS ▼ -3.8%",
    message: "OI -3.8% over 3m — longs being flushed on the way down — capitulation",
    tags: ["red_circle"],
    priority: 3,
  });
  assert.equal(r.kind, "info");
  assert.equal(r.glyph, "flow");   // иконка по типу события, тревоги нет
});

test("направление радара живёт в toastDir, а не в иконке", () => {
  assert.equal(toastDir({ title: "OI #SOL ▲ +5.0%", message: "", tags: [] }), "up");
  assert.equal(toastDir({ title: "OI #PONS ▼ -3.8%", message: "", tags: [] }), "down");
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

// Тег snowflake у breadth-flush несёт снежинку, а не общий warn-треугольник:
// это режим рынка, и он должен отличаться от «что-то сломалось».
test("breadth flush показывает снежинку, тон остаётся warn", () => {
  const r = classifyNotif({ title: "Breadth flush ▼", message: "62% монет валятся · risk-off", tags: ["snowflake"] });
  assert.equal(r.glyph, "cold");
  assert.equal(r.kind, "warn");
});

// Иконка информационного события — по ТИПУ, а не по направлению: иначе радар
// OI, будильник вотчлиста и открытие позы получают одну стрелку на всех.
test("информационные события различаются иконкой", () => {
  const g = (title, tags = []) => classifyNotif({ title, message: "", tags }).glyph;
  assert.equal(g("SHORT #SOPH opened"), "add");
  assert.equal(g("OI #PONS ▼ −3.8%"), "flow");
  assert.equal(g("\u{1F440} #HYPE started moving +2.1%", ["eyes"]), "eye");
  assert.equal(g("Гении Уолл-стрит · 2 событий", ["eyes"]), "history");
});

// Направление остаётся у тех, у кого типа нет, — иначе лента потеряет знак.
test("без опознанного типа остаётся стрелка направления", () => {
  assert.equal(classifyNotif({ title: "BTC ▲ +1.2%", message: "", tags: ["green_circle"] }).glyph, "rising");
  assert.equal(classifyNotif({ title: "что-то нейтральное", message: "", tags: [] }).glyph, "info");
});
