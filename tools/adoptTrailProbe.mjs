// ─────────────────────────────────────────────────
//  adoptTrailProbe — сводка по перелётам трейла adopt
// ─────────────────────────────────────────────────
// Вопрос, ради которого стоит прибор (см. AdoptTrailProbe в strategistAdopt.js):
// трейл настроен отдавать 30% пика, а по 127 сделкам отдавал медиану 40%.
// Виновата петля (позу редко осматривают, и порог перепрыгивают между взглядами)
// или исполнение (решение принято вовремя, но ордер летит и цена уходит)?
//
// Прибор пишет по строке на каждое закрытие трейлом. Здесь эти строки
// собираются в таблицу, где ответ читается сразу:
//
//   • перелёт vs пауза — если перелёт растёт с паузой, виновата петля;
//   • пред.осмотр — если на предыдущем взгляде откат был УЖЕ около порога,
//     петля не виновата: бот увидел вовремя, но не успел выйти;
//   • «нет» в пред.осмотре — поза закрылась на ПЕРВОМ же осмотре после
//     рестарта, такие строки в разбор причины не годятся и считаются отдельно.
//
// ⚠️ Прибор только логирует, торговлю не меняет. Вывод об одной причине не
// делается, пока строк меньше 20: перелёт — величина шумная, а на n<20
// медиана гуляет сильнее, чем сам эффект, который ищем.
//
// Запуск:
//   node tools/adoptTrailProbe.mjs                    # локальные logs/*.log
//   ssh oracle "docker exec hl-paper-scanner node tools/adoptTrailProbe.mjs"
//   node tools/adoptTrailProbe.mjs --json             # машинный вывод

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = process.env.LOG_DIR || "logs";
const AS_JSON = process.argv.includes("--json");

// [AdoptTrailProbe] #COIN перелёт=2.7пп порог=30% факт=32.7% пред.осмотр=26.4% пауза=15.6с
const RE_PROBE =
  /^(\S+ \S+) .*\[AdoptTrailProbe\] #(\S+) перелёт=(-?[\d.]+)пп порог=([\d.]+)% факт=(-?[\d.]+)% пред\.осмотр=(нет|[\d.]+)%? пауза=(нет|[\d.]+)с?/u;

function readProbeLines() {
  if (!existsSync(LOG_DIR)) {
    console.error(`Нет папки ${LOG_DIR}. Прибор пишет в logs/combined*.log внутри контейнера.`);
    process.exit(1);
  }
  // combined.log — свежий, combined1.log и дальше — ротация (чем больше номер,
  // тем старее). Порядок не важен: строки всё равно сортируются по времени.
  const files = readdirSync(LOG_DIR).filter((f) => /^combined\d*\.log$/.test(f));
  const rows = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(join(LOG_DIR, f), "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = RE_PROBE.exec(line);
      if (!m) continue;
      const [, ts, coin, over, gate, actual, prev, gap] = m;
      rows.push({
        ts,
        coin,
        overshootPp: parseFloat(over),
        gatePct: parseFloat(gate),
        actualPct: parseFloat(actual),
        // «нет» = первый осмотр позиции (после рестарта). Не 0 и не ноль-пауза:
        // подставить сюда число значило бы придумать наблюдение.
        prevPct: prev === "нет" ? null : parseFloat(prev),
        gapSec: gap === "нет" ? null : parseFloat(gap),
      });
    }
  }
  // Дедуп: ротация может дать одну строку дважды, если файл копировался.
  const seen = new Set();
  return rows
    .filter((r) => {
      const k = `${r.ts}|${r.coin}|${r.actualPct}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

const q = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};
const fmt = (x, d = 1) => (x == null ? "—" : x.toFixed(d));

function main() {
  const rows = readProbeLines();
  if (AS_JSON) {
    console.log(JSON.stringify({ n: rows.length, rows }, null, 2));
    return;
  }

  console.log("\n  ── Перелёт трейла adopt ──────────────────────────────────\n");
  if (!rows.length) {
    console.log("  Ни одной записи. Прибор пишет только при закрытии по трейлу");
    console.log("  (adopt_trail_tp) — до первого такого выхода таблица пуста.\n");
    return;
  }

  const usable = rows.filter((r) => r.prevPct != null && r.gapSec != null);
  const over = rows.map((r) => r.overshootPp);
  const gate = rows[0].gatePct;

  console.log(`  Записей: ${rows.length} (пригодных для разбора причины: ${usable.length})`);
  console.log(`  Порог отдачи: ${gate}%`);
  console.log(
    `  Факт отдачи:  медиана ${fmt(q(rows.map((r) => r.actualPct), 0.5))}% ` +
      `| p90 ${fmt(q(rows.map((r) => r.actualPct), 0.9))}%`,
  );
  console.log(
    `  Перелёт:      медиана ${fmt(q(over, 0.5))}пп ` +
      `| p90 ${fmt(q(over, 0.9))}пп | макс ${fmt(Math.max(...over))}пп`,
  );

  if (usable.length) {
    console.log(
      `  Пауза между осмотрами: медиана ${fmt(q(usable.map((r) => r.gapSec), 0.5))}с ` +
        `| p90 ${fmt(q(usable.map((r) => r.gapSec), 0.9))}с`,
    );
  }

  // ── Кто виноват ──────────────────────────────────────────────────────────
  // Разделение объявлено заранее и привязано к смыслу, а не к результату:
  // если на предыдущем осмотре откат уже был в пределах 5пп от порога, бот
  // увидел разворот вовремя — перелёт родился между решением и выходом.
  // Если предыдущий осмотр был далеко внизу, порог перепрыгнули вслепую.
  const NEAR_PP = 5;
  const late = usable.filter((r) => r.prevPct < gate - NEAR_PP);
  const onTime = usable.filter((r) => r.prevPct >= gate - NEAR_PP);
  if (usable.length) {
    console.log("\n  Причина перелёта:");
    console.log(
      `    порог перепрыгнут вслепую (пред.осмотр < ${gate - NEAR_PP}%): ` +
        `${late.length} (${((late.length / usable.length) * 100).toFixed(0)}%), ` +
        `медиана паузы ${fmt(q(late.map((r) => r.gapSec), 0.5))}с`,
    );
    console.log(
      `    увидел вовремя, не успел выйти (пред.осмотр ≥ ${gate - NEAR_PP}%): ` +
        `${onTime.length} (${((onTime.length / usable.length) * 100).toFixed(0)}%), ` +
        `медиана паузы ${fmt(q(onTime.map((r) => r.gapSec), 0.5))}с`,
    );
  }

  // ── Связь перелёта с паузой ──────────────────────────────────────────────
  // Если петля виновата, длинные паузы должны давать бóльший перелёт. Считаем
  // медиану перелёта по корзинам паузы — это грубее корреляции, зато читается
  // и не врёт на выбросах.
  if (usable.length >= 6) {
    console.log("\n  Перелёт по длине паузы:");
    const bins = [
      ["< 5с", (r) => r.gapSec < 5],
      ["5–15с", (r) => r.gapSec >= 5 && r.gapSec < 15],
      ["15–60с", (r) => r.gapSec >= 15 && r.gapSec < 60],
      ["≥ 60с", (r) => r.gapSec >= 60],
    ];
    for (const [label, pred] of bins) {
      const b = usable.filter(pred);
      if (!b.length) continue;
      console.log(
        `    ${label.padEnd(8)} n=${String(b.length).padStart(3)} ` +
          `медиана перелёта ${fmt(q(b.map((r) => r.overshootPp), 0.5))}пп`,
      );
    }
  }

  console.log("\n  Последние закрытия:");
  console.log("    время             монета    перелёт  факт   пред.осмотр  пауза");
  for (const r of rows.slice(-12)) {
    console.log(
      `    ${r.ts}  ${r.coin.padEnd(9)} ${(fmt(r.overshootPp) + "пп").padStart(7)} ` +
        `${(fmt(r.actualPct) + "%").padStart(6)} ` +
        `${(r.prevPct == null ? "нет" : fmt(r.prevPct) + "%").padStart(12)} ` +
        `${(r.gapSec == null ? "нет" : fmt(r.gapSec) + "с").padStart(7)}`,
    );
  }

  if (rows.length < 20) {
    console.log(
      `\n  ⚠️  n=${rows.length} — мало. Причину не называем: на такой выборке ` +
        "медиана перелёта\n      гуляет сильнее самого эффекта. Нужно ≥20 закрытий трейлом.",
    );
  }
  console.log("");
}

main();
