#!/usr/bin/env node
/**
 * Собирает страницу «Тело» из экспорта Health Connect.
 *
 *   node tools/bodyReport.mjs ~/Downloads/health_connect_export.db
 *   node tools/bodyReport.mjs "~/Downloads/Health Connect.zip"
 *
 * На вход — .db или .zip прямо из Google Drive (папка health).
 * На выход — самодостаточный tools/body-report.html, который дальше публикуется артефактом.
 *
 * Грабли, зашитые сюда намеренно:
 *  - время в мс, сравнение с текстом молча даёт пустой результат;
 *  - вес и массы в граммах, BMR в ваттах;
 *  - шаги пишут ТРИ источника одновременно (Fitbit / Google Fit / безымянный).
 *    Суммировать нельзя — утроится. Берём max по источникам за день: они зеркалят
 *    одни и те же шаги, но у каждого свои дыры, и max латает дыры не завышая.
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KCAL_PER_KJ = 1 / 4184; // Health Connect держит энергию в джоулях
const WINDOW_DAYS = 35;
const STEP_GOAL = 8000;
const WEIGHT_GOAL = 84;
const WEIGHT_POINTS_NEEDED = 21; // 3 недели — раньше тренд не читается

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

function expandHome(p) {
  return p.startsWith('~') ? path.join(process.env.HOME, p.slice(1)) : p;
}

/** .zip из Drive → распакованный .db во временной папке. Возвращает {dbPath, cleanup}. */
function resolveInput(rawPath) {
  const src = path.resolve(expandHome(rawPath));
  if (!existsSync(src)) die(`Файл не найден: ${src}`);
  if (src.toLowerCase().endsWith('.db')) return { dbPath: src, cleanup: () => {} };
  if (!src.toLowerCase().endsWith('.zip')) die('Ожидался .db или .zip');

  const dir = mkdtempSync(path.join(tmpdir(), 'hc-export-'));
  execFileSync('unzip', ['-oq', src, '-d', dir]);
  const found = readdirSync(dir, { recursive: true }).find((f) => String(f).endsWith('.db'));
  if (!found) die('Внутри zip нет .db — Health Connect поменял формат экспорта?');
  return { dbPath: path.join(dir, String(found)), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const msAt = (isoDate) => `cast(strftime('%s','${isoDate}') as integer)*1000`;

function collect(dbPath) {
  const db = new Database(dbPath, { readonly: true });

  const apps = db.prepare('select row_id, package_name, app_name from application_info_table').all();
  // безымянная строка — внутренний счётчик самого Health Connect (com.android.healthconnect.phone.*)
  const appName = new Map(apps.map((a) => [a.row_id, a.app_name || 'Системный счётчик']));

  // --- шаги: max по источникам за день ---------------------------------------
  const since = new Date(Date.now() - WINDOW_DAYS * 864e5).toISOString().slice(0, 10);
  const perSource = db
    .prepare(
      `select date(start_time/1000,'unixepoch','localtime') d, app_info_id ai, sum(count) v
         from steps_record_table
        where start_time > ${msAt(since)}
        group by d, ai`
    )
    .all();

  const byDay = new Map();
  for (const row of perSource) {
    const slot = byDay.get(row.d) || { d: row.d, steps: 0, sources: {} };
    slot.sources[appName.get(row.ai) || '?'] = row.v;
    slot.steps = Math.max(slot.steps, row.v);
    byDay.set(row.d, slot);
  }

  // дни без единой записи — это ноль, а не разрыв: пропуск скрыл бы правду
  const steps = [];
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 864e5);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    steps.push(byDay.get(key) || { d: key, steps: 0, sources: {} });
  }

  // --- вес: вся история, источник важен ---------------------------------------
  const weight = db
    .prepare(
      `select time t, weight/1000.0 kg, app_info_id ai
         from weight_record_table order by time asc`
    )
    .all()
    .map((r) => ({ t: r.t, kg: +r.kg.toFixed(1), src: appName.get(r.ai) || '?' }));

  // --- состав тела: последний замер весов --------------------------------------
  const last = (table, col, scale = 1) => {
    try {
      const r = db.prepare(`select ${col} v, time t, app_info_id ai from ${table} order by time desc limit 1`).get();
      return r ? { v: r.v * scale, t: r.t, src: appName.get(r.ai) || '?' } : null;
    } catch {
      return null;
    }
  };

  const composition = {
    fatPct: last('body_fat_record_table', 'percentage'),
    leanKg: last('lean_body_mass_record_table', 'mass', 1 / 1000),
    boneKg: last('bone_mass_record_table', 'mass', 1 / 1000),
    waterKg: last('body_water_mass_record_table', 'body_water_mass', 1 / 1000),
    // BMR приходит мощностью в ваттах: Вт × 86400 с / 4184 Дж = ккал/сут
    bmrKcal: last('basal_metabolic_rate_record_table', 'basal_metabolic_rate', (86400 * KCAL_PER_KJ)),
  };

  const exportedAt = db
    .prepare('select max(time) t from weight_record_table')
    .get().t;
  const lastStepAt = db.prepare('select max(start_time) t from steps_record_table').get().t;

  db.close();

  // «источники» = те, кто реально писал данные на этой странице, а не все строки таблицы:
  // там же лежат Оболочка, Сервисы Google Play и прочие, которые к цифрам отношения не имеют
  const contributing = [
    ...new Set([
      ...steps.flatMap((s) => Object.keys(s.sources)),
      ...weight.map((w) => w.src),
      ...Object.values(composition).filter(Boolean).map((c) => c.src),
    ]),
  ];

  return {
    generatedAt: Date.now(),
    dataThrough: Math.max(exportedAt || 0, lastStepAt || 0),
    sources: contributing,
    steps,
    weight,
    composition,
    goals: { STEP_GOAL, WEIGHT_GOAL, WEIGHT_POINTS_NEEDED },
  };
}

// ---------------------------------------------------------------------------

const input = process.argv[2];
if (!input) die('Укажи путь: node tools/bodyReport.mjs ~/Downloads/health_connect_export.db');

const { dbPath, cleanup } = resolveInput(input);
let data;
try {
  data = collect(dbPath);
} finally {
  cleanup();
}

const { renderPage } = await import('./bodyReportTemplate.mjs');
const outPath = path.join(ROOT, 'tools', 'body-report.html');
writeFileSync(outPath, renderPage(data));

// --- отчёт в консоль: видно, что реально приехало ---------------------------
const last30 = data.steps.slice(-30).map((s) => s.steps);
const median = [...last30].sort((a, b) => a - b)[Math.floor(last30.length / 2)];
const w = data.weight.at(-1);
const fmt = (ts) => new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });

console.log(`
  ✓ данные по ${fmt(data.dataThrough)}
  ✓ шаги      ${data.steps.at(-1).steps.toLocaleString('ru-RU')} сегодня · медиана 30д ${median.toLocaleString('ru-RU')}
  ✓ вес       ${w ? `${w.kg} кг (${fmt(w.t)}, ${w.src})` : 'нет записей'} · точек всего ${data.weight.length}
  ✓ страница  ${path.relative(process.cwd(), outPath)}

  дальше: попроси Клода опубликовать её артефактом
`);
