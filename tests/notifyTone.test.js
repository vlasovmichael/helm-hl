// Во что окрашивать пуш: цвет означает ИСХОД, а не тип события.

import test from "node:test";
import assert from "node:assert/strict";

import { classifyNotif, toastDir, parseDigest } from "../src/modules/dashboard/web/src/features/notifyTone.js";

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

test("вход красится СТОРОНОЙ, а не исходом", () => {
  const long = classifyNotif({ title: "LONG #BTC opened", message: "size $40.00", tags: ["green_circle"] });
  const short = classifyNotif({ title: "SHORT #SOL opened", message: "size $10.05", tags: ["red_circle"] });
  assert.equal(long.kind, "up");
  assert.equal(long.glyph, "long");
  assert.equal(short.kind, "down");
  assert.equal(short.glyph, "short");
});

test("авария — danger", () => {
  assert.equal(
    kind("Circuit breaker tripped", "3 losses in a row · entries locked", ["rotating_light"], 5),
    "danger",
  );
  assert.equal(kind("⚠️ Внешнее закрытие #HYPE", "позиции нет на бирже"), "danger");
});

test("радар OI: цвет по направлению, иконка по типу — не тревога", () => {
  const r = classifyNotif({
    title: "OI #PONS ▼ -3.8%",
    message: "OI -3.8% over 3m — longs being flushed on the way down — capitulation",
    tags: ["red_circle"],
    priority: 3,
  });
  assert.equal(r.kind, "down");    // цвет — направление движения
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

// Убыточный лонг: стрелка вверх (сторона) и красная рамка (исход) — обе вещи
// в одной карточке, и одна не подменяет другую.
test("у закрытия со стороной в заголовке иконка — стрелка, цвет — исход", () => {
  const r = classifyNotif({ title: "LONG #DOT closed", message: "PnL −$1.40 · sl_trigger", tags: [] });
  assert.equal(r.glyph, "long");
  assert.equal(r.kind, "loss");
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
  assert.equal(g("OI #PONS ▼ −3.8%"), "flow");
  assert.equal(g("\u{1F440} #HYPE started moving +2.1%", ["eyes"]), "eye");
  assert.equal(g("Гении Уолл-стрит · 2 событий", ["eyes"]), "history");
});

// Направление остаётся у тех, у кого типа нет, — иначе лента потеряет знак.
test("без опознанного типа остаётся стрелка направления", () => {
  assert.equal(classifyNotif({ title: "BTC ▲ +1.2%", message: "", tags: ["green_circle"] }).glyph, "rising");
  assert.equal(classifyNotif({ title: "что-то нейтральное", message: "", tags: [] }).glyph, "info");
});

// Сторону берём только из заголовка: тело дайджеста перечисляет и лонги, и
// шорты, и событие получало сторону первой попавшейся строки.
test("дайджест не считается сделкой из-за LONG в теле", () => {
  const r = classifyNotif({
    title: "Гении Уолл-стрит · 3 событий",
    message: "\u00d7 CLOSE NFLX LONG \u00b7 был $24.4k \u00b7 \u22121.4k",
    tags: ["eyes"],
  });
  assert.equal(r.glyph, "history");
  assert.equal(r.side, null);
});

test("parseDigest разбирает строку на имя, знаковую сумму и метаданные", () => {
  const rows = parseDigest(
    "\u25b2 OPEN BTC LONG \u00b7 $310k \u00b7 10\u00d7 \u00b7 0x4801\u20264a0b\n" +
      "\u00d7 CLOSE xyz:NFLX LONG \u00b7 был $24.4k \u00b7 \u2212$1.4k \u00b7 4д \u00b7 0x4801\u20264a0b\n" +
      "\nЧужие входы, видны постфактум. Не сигнал.",
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, "open");
  assert.equal(rows[0].pnl, null);          // у открытия исхода ещё нет
  assert.equal(rows[1].kind, "close");
  assert.equal(rows[1].head, "xyz:NFLX LONG");
  assert.equal(rows[1].sign, "neg");
  assert.equal(rows[1].meta, "был $24.4k \u00b7 4д \u00b7 0x4801\u20264a0b");
});

test("parseDigest на обычном теле отдаёт null", () => {
  assert.equal(parseDigest("size $10.05 \u00b7 entry $100.54"), null);
});
