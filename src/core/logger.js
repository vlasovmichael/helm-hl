import winston from "winston";
import { mkdirSync } from "fs";

mkdirSync("logs", { recursive: true });

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

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  transports: [
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
  ],
});
