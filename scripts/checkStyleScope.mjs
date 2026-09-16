// ─────────────────────────────────────────────────────────────────────
//  Проверка области действия стилей страницы.
//
//  Сборка кладёт CSS всех страниц в ОДИН файл (cssCodeSplit: false), поэтому
//  правило, написанное «для своей страницы», приезжает на все остальные.
//
//  🚨 Вне core/ селектор верхнего уровня обязан нести класс, id или атрибут:
//  голый `body` / `tfoot td` перекрашивает и переверстывает чужие страницы.
//  Своя раскладка страницы живёт под body[data-page="…"].
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const STYLES = join(ROOT, "src/modules/dashboard/web");

// core/ — общий каркас: голые html/body/table там и должны стоять.
const isCore = (p) => /\/styles\/core[./]/.test(p);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".scss") && !isCore(full)) out.push(full);
  }
  return out;
}

/** Селектор безопасен, если каждая его ветка сужена классом, id или атрибутом. */
const scoped = (sel) =>
  sel
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .every((s) => /[.#[]/.test(s));

/**
 * Заголовки блоков верхнего уровня: { header, line }. Блок считается верхним,
 * пока над ним только at-правила (@media, @include) — они не сужают селектор.
 * Внутри @keyframes заголовки — from/to/50%, классов там не бывает.
 */
function topLevelHeaders(src) {
  const out = [];
  const stack = [];
  let head = "";
  let line = 1;

  for (const ch of src) {
    if (ch === "\n") line++;
    if (ch === "{") {
      const header = head.trim();
      const atRule = header.startsWith("@");
      if (!atRule && stack.every((s) => s !== "rule") && !stack.includes("frames")) {
        out.push({ header, line });
      }
      stack.push(atRule ? (/^@keyframes/.test(header) ? "frames" : "at") : "rule");
      head = "";
    } else if (ch === "}") {
      stack.pop();
      head = "";
    } else if (ch === ";") {
      head = "";
    } else {
      head += ch;
    }
  }
  return out;
}

const problems = [];

for (const file of walk(STYLES)) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([^\n]*?)\/\/[^\n]*$/gm, (m, keep) => keep.padEnd(m.length));

  for (const { header, line } of topLevelHeaders(src)) {
    if (!header || scoped(header)) continue;
    problems.push(`${rel}:${line}  ${header.replace(/\s+/g, " ").slice(0, 70)}`);
  }
}

if (problems.length) {
  console.error(
    "Стили страницы бьют по всем страницам — сузьте селектор классом или body[data-page]:\n",
  );
  for (const p of problems) console.error("  " + p);
  console.error(`\n${problems.length} проблем`);
  process.exit(1);
}
console.log("✓ стили: селекторы вне core сужены, общий файл не протекает");
