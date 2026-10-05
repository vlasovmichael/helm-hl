import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = "src/modules/dashboard/web";
const includeTokens = process.argv.includes("--tokens");
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "dev") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (/\.(scss|css|js)$/.test(name) && (includeTokens || !path.endsWith("src/styles/core/_tokens.scss"))) files.push(path);
  }
}
walk(join(root, "src"));
for (const name of readdirSync(root)) if (/\.js$/.test(name)) files.push(join(root, name));

function semantic(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 24) return max > 220 ? "--accent-ink" : max < 70 ? "--ink" : "--ink-3";
  if (r > g * 1.25 && r > b * 1.25) return "--loss";
  if (g > r * 1.15 && g > b * 1.05) return "--gain";
  if (r > b * 1.3 && g > b * 1.15) return "--caution";
  return "--accent";
}
function color(r, g, b, alpha) {
  const token = `var(${semantic(r, g, b)})`;
  return alpha == null || alpha >= 1 ? token : `color-mix(in srgb, ${token} ${(alpha * 100).toFixed(2)}%, transparent)`;
}
function palette(r, g, b, alpha) {
  const token = semantic(r, g, b).replace("--accent-ink", "--color-gray-0").replace("--gain", "--color-green-500").replace("--loss", "--color-red-400").replace("--caution", "--color-amber-400").replace("--accent", "--color-blue-500").replace("--ink-3", "--color-gray-500").replace("--ink", "--color-gray-800");
  const value = `var(${token})`;
  return alpha == null || alpha >= 1 ? value : `color-mix(in srgb, ${value} ${(alpha * 100).toFixed(2)}%, transparent)`;
}
function replace(text) {
  text = text.replace(/#([0-9a-f]{3,8})\b/gi, (_, hex) => {
    const full = hex.length <= 4 ? [...hex.slice(0, hex.length === 4 ? 3 : hex.length)].map((x) => x + x).join("") : hex.slice(0, 6);
    const alpha = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : null;
    const fn = includeTokens ? palette : color;
    return fn(parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16), alpha);
  });
  return text.replace(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/gi, (_, r, g, b, a) => (includeTokens ? palette : color)(+r, +g, +b, a == null ? null : +a));
}
for (const file of files) {
  const before = readFileSync(file, "utf8");
  const after = replace(before);
  if (after !== before) writeFileSync(file, after);
}
