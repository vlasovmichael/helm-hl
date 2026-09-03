// ─────────────────────────────────────────────────────────────────────
//  Проверка: в интерфейсе нет типографских глифов и эмодзи вместо иконок,
//  и разметка icon() не уезжает в textContent.
//
//  Заведена 04.09.2026, после того как «перевели иконки на lucide» пришлось
//  доделывать четырьмя заходами: каждый раз находилось ещё одно место, и
//  находил его пользователь, а не я. Теперь находит `npm test`.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../src/modules/dashboard/web", import.meta.url).pathname;

// Стрелки, геометрия, эмодзи, dingbats.
const GLYPH = /[\u{1F300}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}]/u;
// Типографика, которая остаётся текстом и иконкой быть не может.
//
// → и ← здесь законны: в прозе это «из чего во что» («4h → 1h → 5m», «holds
// 58k → bounce to 60.8»), а не значок. Иконкой они становятся, только когда
// стоят ОДНИ в ячейке или чипе — такие места правятся глазами при ревью,
// автоматика их от прозы не отличит.
const OK = /[—–·«»„“”‘’…×≈≥≤≠−→←]/u;

/** Комментарии и регулярки — не интерфейс: глифы в них законны. */
function blankNonUi(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/^([^\n]*?)\/\/[^\n]*$/gm, (m, keep) => keep.padEnd(m.length))
    .replace(/\/\^?\[[^\]\n]*\][^\n]{0,20}?\/[gimsuy]*/g, (m) => " ".repeat(m.length))
    .replace(/\/[^/\n*][^\n]*?\/\.test\(/g, (m) => " ".repeat(m.length));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|html)$/.test(name)) out.push(full);
  }
  return out;
}

const problems = [];
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  // Стенд симулятора стакана — служебная песочница, в интерфейс не входит.
  if (rel === "orderbook-sim.html") continue;
  const src = blankNonUi(readFileSync(file, "utf8"));
  src.split("\n").forEach((line, i) => {
    const hit = [...line].find((ch) => GLYPH.test(ch) && !OK.test(ch));
    if (hit) problems.push(`${rel}:${i + 1}  глиф ${hit} вместо icon()  ${line.trim().slice(0, 70)}`);
    if (/textContent\s*=/.test(line) && /\bicon\(|\bglyph\(/.test(line)) {
      problems.push(`${rel}:${i + 1}  icon() в textContent — напечатает сырой <svg>`);
    }
  });
}

if (problems.length) {
  console.error("Глифы/эмодзи в интерфейсе (нужен icon() из core/icon.js):\n");
  for (const p of problems) console.error("  " + p);
  console.error(`\n${problems.length} проблем`);
  process.exit(1);
}
console.log("✓ иконки: глифов и эмодзи в интерфейсе нет");
