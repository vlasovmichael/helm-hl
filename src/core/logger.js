import winston from "winston";
import Transport from "winston-transport";
import { mkdirSync } from "fs";

// ── In-memory ring buffer для live-логов на дашборде ─────────────────
const LOG_BUFFER_SIZE = 500;
const logBuffer = [];
const logSubscribers = new Set();
let logSeq = 0;

class RingBufferTransport extends Transport {
  log(info, callback) {
    setImmediate(() => this.emit("logged", info));
    const entry = {
      id: ++logSeq,
      ts: Date.now(),
      level: info[Symbol.for("level")] || info.level,
      message: typeof info.message === "string" ? info.message : String(info.message ?? ""),
    };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    for (const fn of logSubscribers) {
      try { fn(entry); } catch { /* ignore */ }
    }
    callback();
  }
}

export function getLogBuffer() {
  return logBuffer.slice();
}

export function subscribeLogs(fn) {
  logSubscribers.add(fn);
  return () => logSubscribers.delete(fn);
}

// В тестах не создаём папку logs/ и не пишем туда — иначе test runs
// засирают combined.log сообщениями от мокнутых вызовов analyze().
const isTest = process.env.NODE_ENV === "test";

if (!isTest) {
  mkdirSync("logs", { recursive: true });
}

const { combine, timestamp, printf, errors } = winston.format;

const lineFormat = printf(({ level, message, timestamp, stack }) => {
  return stack
    ? `${timestamp} [${level.toUpperCase()}]: ${message}\n${stack}`
    : `${timestamp} [${level.toUpperCase()}]: ${message}`;
});

const fileFormat = combine(
  errors({ stack: true }),
  timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  lineFormat,
);

const MODULE_PREFIX = /^\[([A-Za-z][\w-]*)\]\s*/;
const FIXED = new Set(["time", "level", "module", "msg", "stack", "message", "timestamp"]);

// stdout — JSON для Loki (`| json | module="Adopt"`); файлы и лента дашборда остаются текстом.
// Префикс `[Модуль]` уходит в поле module, стек ошибки — одним полем, а не россыпью строк.
export function jsonLine(info, now = new Date()) {
  const text = typeof info.message === "string" ? info.message : String(info.message ?? "");
  const prefix = MODULE_PREFIX.exec(text);
  const line = { time: now.toISOString(), level: info.level };
  if (prefix) line.module = prefix[1];
  line.msg = prefix ? text.slice(prefix[0].length) : text;
  for (const [key, value] of Object.entries(info)) {
    if (!FIXED.has(key)) line[key] = value;
  }
  if (info.stack) line.stack = info.stack;
  try {
    return JSON.stringify(line);
  } catch {
    // Циклический meta не должен ронять логирование.
    return JSON.stringify({ time: line.time, level: line.level, module: line.module, msg: line.msg });
  }
}

const consoleFormat = combine(
  errors({ stack: true }),
  printf((info) => jsonLine(info)),
);

// В тестах: один молчаливый Console transport — winston требует хотя
// бы один transport, иначе ругается. silent=true глушит весь вывод.
const transports = isTest
  ? [new winston.transports.Console({ format: consoleFormat, silent: true })]
  : [
      new winston.transports.Console({
        format: consoleFormat,
      }),
      new winston.transports.File({
        filename: "logs/combined.log",
        format: fileFormat,
        maxsize: 2_000_000, // 2 MB — жёсткий лимит на файл
        maxFiles: 20, // 20 архивов ≈ 40 MB макс
        tailable: true, // combined.log = всегда текущий (ротируются numbered: .1, .2…)
      }),
      new winston.transports.File({
        filename: "logs/error.log",
        level: "error",
        format: fileFormat,
        maxsize: 2_000_000, // 2 MB
        maxFiles: 20, // 20 архивов для ошибок (40 MB макс)
        tailable: true,
      }),
      new RingBufferTransport({ level: process.env.LOG_LEVEL || "info" }),
    ];

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  // errors на уровне логгера: в формате транспорта winston теряет message у logger.error(err).
  format: errors({ stack: true }),
  transports,
});
