// ─────────────────────────────────────────────────────────────────────
//  Проверка комментариев: комментарий объясняет КОД, а не рассказывает,
//  как его писали.
//
//  Ловит: даты, хеши коммитов, слова-маркеры хроники («раньше», «пробовали»),
//  простыни длиннее лимита. Правила — в CLAUDE.md.
//
//  🚨 Ничего не переписывает: находит и валит `npm test`. Автозамена по
//  пробелам ломает выравнивание таблиц и отступы шапок.
// ─────────────────────────────────────────────────────────────────────
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN = ["src", "scripts", "tests"];
// tools/*.mjs — протокол гипотезы (предзаявка, правило решения, стоп-правило).
// Дата предзаявки там обязательна, длина оправдана.
const SKIP_DIRS = new Set(["node_modules", "dist", "tools", "data", "logs"]);

const MAX_BLOCK_LINES = 6;   // сплошной блок комментария вне шапки файла

const RULES = [
  { id: "дата", re: /(?:^|[^\d.])(0[1-9]|[12]\d|3[01])\.(0[1-9]|1[0-2])(?:\.20\d\d)?(?![\d.])/ },
  { id: "хеш коммита", re: /(?<![\w.])(?=[0-9a-f]{7,40}(?![\w.]))[0-9]*[a-f][0-9a-f]*(?![\w.])/ },
  {
    id: "хроника",
    re: /(?<!\p{L})(раньше|ранее|до этого|прошл(ая|ой) верси|стар(ая|ой) верси|пробовал\p{L}*|откатил\p{L}*|не понравил\p{L}*|в прошлый заход|как выяснилось|исторически)(?!\p{L})/iu,
  },
];

const files = [];
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(js|mjs)$/.test(p)) files.push(p);
  }
}
for (const d of SCAN) walk(join(ROOT, d));

/** Строки-комментарии файла: { line, text, inHeader } */
function commentLines(src) {
  const out = [];
  let inBlock = false;
  let headerOpen = true;   // шапка = сплошной комментарий с первой строки файла
  src.split("\n").forEach((raw, i) => {
    const s = raw.trim();
    const isLine = s.startsWith("//");
    const opens = s.startsWith("/*");
    if (headerOpen && !isLine && !opens && !inBlock && s !== "") headerOpen = false;
    if (inBlock || isLine || opens) {
      out.push({ line: i + 1, text: s, inHeader: headerOpen });
    }
    if (opens && !s.includes("*/")) inBlock = true;
    if (inBlock && s.includes("*/")) inBlock = false;
  });
  return out;
}

const problems = [];
for (const file of files) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");
  const comments = commentLines(src);

  for (const c of comments) {
    for (const rule of RULES) {
      const m = c.text.match(rule.re);
      if (m) problems.push({ rel, line: c.line, rule: rule.id, text: c.text.slice(0, 100) });
    }
  }

  // Простыня: подряд идущие строки ПРОЗЫ вне шапки файла. Хвост JSDoc (@param,
  // @returns) структурный, длину не раздувает — считаем до первого тега.
  let run = [];
  const flushRun = () => {
    // Хвост-справочник (@param, · перечисление) структурный — прозу считаем до него.
    const tag = run.findIndex((c) => /^(\*|\/\/)?\s*[@·•-]\s*\S/.test(c.text));
    const body = (tag === -1 ? run : run.slice(0, tag))
      .filter((c) => !/^(\/\*\*?|\*\/?|\/\/)$/.test(c.text));   // пустые строки-разделители
    const prose = body.length;
    if (prose > MAX_BLOCK_LINES) {
      problems.push({
        rel, line: run[0].line, rule: `простыня ${prose} строк`,
        text: run[0].text.slice(0, 100),
      });
    }
    run = [];
  };
  let prev = -2;
  for (const c of comments) {
    if (c.inHeader) { flushRun(); prev = c.line; continue; }
    if (c.line === prev + 1) run.push(c);
    else { flushRun(); run = [c]; }
    prev = c.line;
  }
  flushRun();
}

const byFile = new Map();
for (const p of problems) byFile.set(p.rel, (byFile.get(p.rel) ?? 0) + 1);

if (process.argv.includes("--stats")) {
  const by = new Map();
  for (const p of problems) {
    const k = p.rule.startsWith("простыня") ? "простыня" : p.rule;
    by.set(k, (by.get(k) ?? 0) + 1);
  }
  console.log([...by].map(([k, v]) => `${k}: ${v}`).join("\n"));
  console.log(`файлов затронуто: ${byFile.size} из ${files.length}`);
  console.log([...byFile].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([f, n]) => `  ${n}  ${f}`).join("\n"));
  process.exit(0);
}

// Храповик: долг зафиксирован пофайлово, вниз двигаться можно, вверх — нет.
// `--update` перезаписывает планку после чистки.
const DEBT_PATH = join(ROOT, "scripts/comment-debt.json");
if (process.argv.includes("--update")) {
  const debt = Object.fromEntries([...byFile].sort());
  writeFileSync(DEBT_PATH, `${JSON.stringify(debt, null, 2)}\n`);
  console.log(`[checkComments] планка обновлена: ${problems.length} в ${byFile.size} файлах`);
  process.exit(0);
}

if (process.argv.includes("--all")) {
  const only = process.argv.slice(process.argv.indexOf("--all") + 1).filter((a) => !a.startsWith("-"));
  for (const p of problems) {
    if (only.length && !only.some((o) => p.rel.includes(o))) continue;
    console.log(`${p.rel}:${p.line}  [${p.rule}]  ${p.text}`);
  }
  process.exit(0);
}

let debt = {};
try { debt = JSON.parse(readFileSync(DEBT_PATH, "utf8")); } catch { /* планки нет — всё новое */ }

const fresh = [];
for (const [rel, n] of byFile) {
  const allowed = debt[rel] ?? 0;
  if (n > allowed) fresh.push({ rel, n, allowed });
}

if (fresh.length) {
  console.error(`[checkComments] новые нарушения в ${fresh.length} файл(ах):\n`);
  for (const f of fresh) {
    console.error(`  ${f.rel}: ${f.n} при планке ${f.allowed}`);
    for (const p of problems.filter((x) => x.rel === f.rel)) {
      console.error(`    :${p.line}  [${p.rule}]  ${p.text}`);
    }
  }
  console.error(`\nПравила — CLAUDE.md, раздел «Комментарии в коде».`);
  console.error(`Долг ниже планки опускать можно (${DEBT_PATH.replace(ROOT, "")} обновляется через --update).`);
  process.exit(1);
}

const total = [...byFile.values()].reduce((a, b) => a + b, 0);
const planned = Object.values(debt).reduce((a, b) => a + b, 0);
console.log(`[checkComments] ✅ новых нарушений нет | долг ${total} (планка ${planned})`);
