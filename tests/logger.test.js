import test from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import winston from "winston";

import { jsonLine } from "../src/core/logger.js";

const NOW = new Date("2026-10-09T08:30:22.173Z");
const parse = (info) => JSON.parse(jsonLine(info, NOW));

test("логгер: префикс [Модуль] уходит в поле module", () => {
  assert.deepEqual(parse({ level: "info", message: "[System] ✅ State saved" }), {
    time: "2026-10-09T08:30:22.173Z",
    level: "info",
    module: "System",
    msg: "✅ State saved",
  });
});

test("логгер: без префикса module нет, текст целиком", () => {
  const line = parse({ level: "warn", message: "просто строка [не модуль]" });
  assert.equal(line.module, undefined);
  assert.equal(line.msg, "просто строка [не модуль]");
});

test("логгер: стек ошибки одним полем", () => {
  const line = parse({ level: "error", message: "[Tax] упало", stack: "Error: упало\n    at x (a.js:1:1)" });
  assert.equal(line.stack, "Error: упало\n    at x (a.js:1:1)");
  assert.equal(jsonLine({ level: "error", message: "x", stack: "a\nb" }, NOW).includes("\n"), false);
});

test("логгер: meta добавляется, но не перетирает level и msg", () => {
  const line = parse({ level: "info", message: "[DB] ok", coin: "BTC", level_hint: 1, msg: "чужое", module: "чужой" });
  assert.equal(line.coin, "BTC");
  assert.equal(line.msg, "ok");
  assert.equal(line.module, "DB");
});

test("логгер: циклический meta не роняет запись", () => {
  const meta = {};
  meta.self = meta;
  const line = parse({ level: "info", message: "[System] цикл", meta });
  assert.equal(line.msg, "цикл");
  assert.equal(line.meta, undefined);
});

test("логгер: не-строковое сообщение приводится к строке", () => {
  assert.equal(parse({ level: "info", message: 42 }).msg, "42");
});

test("логгер: logger.error(err) сохраняет сообщение и стек", async () => {
  const { logger } = await import("../src/core/logger.js");
  const lines = [];
  const stream = new Writable({ write(chunk, _enc, done) { lines.push(JSON.parse(chunk)); done(); } });
  const probe = new winston.transports.Stream({ stream, format: winston.format.printf((info) => jsonLine(info, NOW)) });
  logger.add(probe);
  try {
    logger.error(new Error("[Exchange] 502 от HL"));
  } finally {
    logger.remove(probe);
  }
  assert.equal(lines[0].module, "Exchange");
  assert.equal(lines[0].msg, "502 от HL");
  assert.match(lines[0].stack, /^Error: \[Exchange\] 502 от HL/);
});
