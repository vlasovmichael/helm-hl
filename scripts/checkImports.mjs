// ─────────────────────────────────────────────────────────────────────
//  Проверка: каждый локальный импорт указывает на существующий файл —
//  С ТЕМ ЖЕ РЕГИСТРОМ, что у файла на диске.
//
//  🚨 Зачем отдельная проверка, если сборка и так упадёт: на macOS она НЕ
//  упадёт. Тамошняя файловая система регистр не различает, поэтому
//  `@use "core/hoverCard"` спокойно находит `_hovercard.scss`, всё собирается
//  локально — и падает в Linux-контейнере при деплое, то есть в проде.
//
//  Проверяются относительные импорты JS (`import ... from "./x.js"`) и
//  партиалы Sass (`@use` / `@forward` / `@import` с относительным путём).
//  Пакеты из node_modules не наша забота.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKIP = new Set(["node_modules", "dist", ".git", "data", "logs", "temp"]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|scss)$/.test(name)) out.push(full);
  }
  return out;
}

/** Есть ли файл на диске ИМЕННО с таким именем (регистр важен). */
function existsExact(path) {
  if (!existsSync(path)) return false;
  const dir = dirname(path);
  try {
    return readdirSync(dir).includes(basename(path));
  } catch {
    return false;
  }
}

/** Кандидаты имён файла для Sass-партиала: `core/x` → `core/_x.scss`, `core/x.scss`. */
function sassCandidates(spec, fromDir) {
  const dir = dirname(resolve(fromDir, spec));
  const name = basename(spec);
  return [
    join(dir, `_${name}.scss`),
    join(dir, `${name}.scss`),
    join(dir, name, "_index.scss"),
  ];
}

/** Как файл называется на диске на самом деле (для внятного сообщения). */
function actualName(path) {
  try {
    const want = basename(path).toLowerCase();
    return readdirSync(dirname(path)).find((n) => n.toLowerCase() === want) || null;
  } catch {
    return null;
  }
}

/** Комментарии — не код: примеры путей в шапке файла проверять нечего. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([^\n]*?)\/\/[^\n]*$/gm, (m, keep) => keep.padEnd(m.length));
}

const problems = [];

for (const file of walk(ROOT)) {
  const src = stripComments(readFileSync(file, "utf8"));
  const dir = dirname(file);
  const rel = relative(ROOT, file);

  if (/\.scss$/.test(file)) {
    for (const m of src.matchAll(/@(?:use|forward|import)\s+["']([^"']+)["']/g)) {
      const spec = m[1];
      if (spec.startsWith("sass:") || spec.startsWith("~") || /^https?:/.test(spec)) continue;
      const candidates = sassCandidates(spec, dir);
      if (!candidates.some(existsExact)) {
        const looseHit = candidates.find((c) => existsSync(c));
        const real = looseHit && actualName(looseHit);
        problems.push(
          `${rel}: @use "${spec}" — ` +
            (real ? `на диске ${real}, отличается регистр` : "файла нет"),
        );
      }
    }
    continue;
  }

  for (const m of src.matchAll(/from\s+["'](\.[^"']+)["']|import\s*\(\s*["'](\.[^"']+)["']/g)) {
    const spec = (m[1] || m[2]).split("?")[0];
    const target = resolve(dir, spec);
    if (!existsExact(target)) {
      const real = actualName(target);
      problems.push(
        `${rel}: import "${spec}" — ` +
          (real ? `на диске ${real}, отличается регистр` : "файла нет"),
      );
    }
  }
}

if (problems.length) {
  console.error("Импорты, которых нет на диске (или отличается регистр):\n");
  for (const p of problems) console.error("  " + p);
  console.error(
    `\n${problems.length} проблем. 🚨 На macOS такой импорт работает, в Linux-контейнере — нет.`,
  );
  process.exit(1);
}
console.log("✓ импорты: пути и регистр совпадают с файлами на диске");
