import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const WEB = join(ROOT, "src/modules/dashboard/web");
const DEBT_PATH = join(ROOT, "scripts/raw-color-debt.json");
const extensions = new Set([".scss", ".css", ".js"]);
const rawColor = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/gi;
const files = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "dev") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path);
    else if (extensions.has(path.slice(path.lastIndexOf(".")))) files.push(path);
  }
}

walk(join(WEB, "src"));
for (const entry of readdirSync(WEB)) {
  const path = join(WEB, entry);
  if (statSync(path).isFile() && extensions.has(path.slice(path.lastIndexOf(".")))) files.push(path);
}

const counts = Object.fromEntries(files.sort().flatMap((path) => {
  if (path.endsWith("src/styles/core/_tokens.scss")) return [];
  const count = (readFileSync(path, "utf8").match(rawColor) ?? []).length;
  return count ? [[relative(ROOT, path), count]] : [];
}));

if (process.argv.includes("--update")) {
  writeFileSync(DEBT_PATH, `${JSON.stringify(counts, null, 2)}\n`);
  console.log(`[checkRawColors] планка обновлена: ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
  process.exit(0);
}

let debt = {};
try { debt = JSON.parse(readFileSync(DEBT_PATH, "utf8")); } catch { /* нет планки — всё новое */ }
const fresh = Object.entries(counts).filter(([file, count]) => count > (debt[file] ?? 0));
if (fresh.length) {
  console.error("[checkRawColors] вырос долг:");
  fresh.forEach(([file, count]) => console.error(`  ${file}: ${count} при планке ${debt[file] ?? 0}`));
  process.exit(1);
}
console.log(`[checkRawColors] ✅ новых сырых цветов нет | долг ${Object.values(counts).reduce((a, b) => a + b, 0)}`);
