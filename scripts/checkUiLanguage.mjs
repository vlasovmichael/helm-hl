// ─────────────────────────────────────────────────────────────────────
//  Проверка языка интерфейса: всё, что видит глаз в браузере, — по-английски.
//
//  Комментарии, логи и тексты пушей остаются русскими намеренно: это
//  внутренняя речь проекта и алерты оператора. Английский обязателен ровно на
//  трёх поверхностях, откуда текст доезжает до экрана:
//
//    A. фронтенд дашборды (web/**: js, html, scss);
//    B. HTTP-роуты и server.js — всё, кроме строк внутри logger.*;
//    C. health-детали: `detail:` / `detail =` / noteMirror(...) в любом
//       модуле — они складываются в тултип плашки «Data ok».
//
//  🚨 Такие переводы доделываются заходами: русский всплывал в тултипе
//  плашки данных уже после того, как интерфейс считался англоязычным. Пусть
//  находит `npm test`, а не читатель репозитория.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;
const WEB = join(SRC, "modules/dashboard/web");
const ROUTES = join(SRC, "modules/dashboard/routes");
const SERVER = join(SRC, "modules/dashboard/server.js");

const CYR = /[Ѐ-ӿ]/;
// Строковый литерал: кавычки, апострофы, бэктики — без переносов строки.
const STRING = /"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g;

/** Комментарии — не интерфейс: русский в них законен. */
function blankComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([^\n]*?)\/\/[^\n]*$/gm, (m, keep) => keep.padEnd(m.length));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|html|scss)$/.test(name)) out.push(full);
  }
  return out;
}

const problems = [];

/**
 * Строка внутри вызова logger.*() — включая продолжения многострочного
 * вызова. Считаем скобки: пока вызов не закрылся, следующие строки тоже его.
 */
function loggerLines(lines) {
  const inside = new Array(lines.length).fill(false);
  let depth = 0;
  lines.forEach((line, i) => {
    if (depth > 0) inside[i] = true;
    const opens = /logger\.\w+\(|console\.\w+\(/.test(line);
    if (opens) inside[i] = true;
    if (opens || depth > 0) {
      // Скобки внутри строковых литералов не считаются: `${...}` их ломает.
      const bare = line.replace(STRING, "");
      depth += (bare.match(/\(/g) ?? []).length - (bare.match(/\)/g) ?? []).length;
      if (depth < 0) depth = 0;
    }
  });
  return inside;
}

/** Поверхность A и B: любой русский текст, кроме строк внутри logger.*. */
function checkSurface(files, { allowLogger }) {
  for (const file of files) {
    const rel = relative(SRC, file);
    // dev-моки проверяем тоже: текст из мока рисуется теми же шаблонами, что
    // и живой, и русский из мока уезжает на экран при `?mock`.
    const raw = readFileSync(file, "utf8").split("\n");
    const lines = blankComments(readFileSync(file, "utf8")).split("\n");
    const inLogger = allowLogger ? loggerLines(lines) : null;
    lines.forEach((line, i) => {
      if (inLogger?.[i]) return;
      // Осознанное исключение: русский здесь — данные (ключ словаря, разбор
      // чужого ответа), а не текст экрана.
      if (raw[i].includes("i18n-ok")) return;
      const hit = (line.match(STRING) ?? []).find((s) => CYR.test(s));
      if (hit) problems.push(`${rel}:${i + 1}  русский в интерфейсе: ${hit.slice(0, 70)}`);
    });
  }
}

checkSurface(walk(WEB), { allowLogger: false });
checkSurface([...walk(ROUTES), SERVER], { allowLogger: true });

/** Поверхность C: health-детали в любом модуле — они видны в тултипе. */
for (const file of walk(SRC)) {
  if (file.startsWith(WEB) || file.startsWith(ROUTES) || file === SERVER) continue;
  const rel = relative(SRC, file);
  const raw = readFileSync(file, "utf8").split("\n");
  const lines = blankComments(readFileSync(file, "utf8")).split("\n");
  lines.forEach((line, i) => {
    if (!/\bdetail\s*[:=]|noteMirror\(/.test(line)) return;
    if (raw[i].includes("i18n-ok")) return;
    const hit = (line.match(STRING) ?? []).find((s) => CYR.test(s));
    if (hit) problems.push(`${rel}:${i + 1}  русский в health-детали: ${hit.slice(0, 70)}`);
  });
}

if (problems.length) {
  console.error("Русский текст на англоязычных поверхностях интерфейса:\n");
  for (const p of problems) console.error("  " + p);
  console.error(`\n${problems.length} проблем`);
  process.exit(1);
}
console.log("✓ язык интерфейса: русского на видимых поверхностях нет");
