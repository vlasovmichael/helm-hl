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
//  Из пакетов проверяется одно: серверный код не достаёт до devDependencies.
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

// Сервер не должен доходить до devDependencies ни напрямую, ни через фронтовый
// модуль: в образ они не ставятся (npm ci --omit=dev), и контейнер падает на старте.
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const devOnly = new Set(
  Object.keys(pkg.devDependencies || {}).filter((n) => !(n in (pkg.dependencies || {}))),
);
const WEB = join(ROOT, "src/modules/dashboard/web") + "/";
const pkgName = (spec) =>
  spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];

function jsImports(file) {
  const src = stripComments(readFileSync(file, "utf8"));
  const specs = [];
  for (const m of src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) specs.push(m[1]);
  return specs;
}

const serverRoots = walk(join(ROOT, "src")).filter(
  (f) => /\.(js|mjs)$/.test(f) && !f.startsWith(WEB),
);
const seen = new Map(); // файл → откуда пришли
const queue = [];
for (const f of serverRoots) {
  seen.set(f, null);
  queue.push(f);
}
while (queue.length) {
  const file = queue.shift();
  for (const spec of jsImports(file)) {
    if (spec.startsWith(".")) {
      const target = resolve(dirname(file), spec.split("?")[0]);
      if (existsExact(target) && !seen.has(target)) {
        seen.set(target, file);
        queue.push(target);
      }
      continue;
    }
    if (!devOnly.has(pkgName(spec))) continue;
    const chain = [];
    for (let f = file; f; f = seen.get(f)) chain.unshift(relative(ROOT, f));
    problems.push(`${chain.join(" → ")} → "${spec}" — пакет из devDependencies, в прод-образе его нет`);
  }
}

if (problems.length) {
  console.error("Импорты, которые сломаются в Linux-контейнере:\n");
  for (const p of problems) console.error("  " + p);
  console.error(
    `\n${problems.length} проблем. Локально такой импорт работает, в прод-образе — нет.`,
  );
  process.exit(1);
}
console.log("✓ импорты: пути и регистр совпадают с файлами, сервер не тянет dev-пакеты");
