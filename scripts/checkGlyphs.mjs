// ─────────────────────────────────────────────────────────────────────
//  Проверка интерфейса дашборда:
//    · нет типографских глифов и эмодзи вместо иконок;
//    · разметка icon() не уезжает в textContent;
//    · подсказки идут через data-tip, а не через нативный `title`.
//
//  🚨 Такие переводы доделываются заходами: каждый раз находится ещё одно
//  место. Пусть находит `npm test`, а не пользователь.
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
    // .scss тоже интерфейс: глиф умеет приехать из content/list-style —
    // так ⚠ в маркере списка предупреждений пережил перевод на lucide.
    else if (/\.(js|html|scss)$/.test(name)) out.push(full);
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
    // Нативный `title` на телефоне не показывается вовсе, и подсказка,
    // написанная в него, становится недоступной. См. core/tooltip.js.
    if (/\stitle="/.test(line) || /\.title\s*=\s*[`"']/.test(line)) {
      problems.push(`${rel}:${i + 1}  нативный title — подсказка идёт через data-tip  ${line.trim().slice(0, 60)}`);
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
