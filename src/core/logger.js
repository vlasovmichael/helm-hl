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

const { combine, timestamp, printf, colorize, errors } = winston.format;

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

const consoleFormat = combine(
  errors({ stack: true }),
  timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
  colorize({ all: true }),
  lineFormat,
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
  transports,
});
