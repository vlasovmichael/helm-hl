// ─────────────────────────────────────────────────
//  Forward Watch — сторож форвард-накопителей
// ─────────────────────────────────────────────────
// Раз в час по каждому идущему форварду:
//   - сборщик молчит дольше своего ритма → один пуш на эпизод молчания;
//   - стоп-правило выполнено → один пуш и один запуск оценки по предзаявке,
//     вывод ложится в data/hypotheses/auto-evals.jsonl.
// Реестр отсюда не пишется: он живёт в hl-lab, прод его только подтягивает.

import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FORWARDS, classifyHypotheses, forwardProgress, readRegistry } from '../modules/forwards.js';
import { readJsonl } from '../../tools/researchStats.mjs';
import { fireNtfy } from '../core/ntfy.js';
import { logger } from '../core/logger.js';

const run = promisify(execFile);
const DIR = join('data', 'hypotheses');
const STATE = join(DIR, 'forward-watch.json');
export const AUTO_EVALS = join(DIR, 'auto-evals.jsonl');
const INTERVAL_MS = 3_600_000;
const EVAL_TIMEOUT_MS = 5 * 60_000;

/**
 * Что сделать на этом проходе. Чистая функция.
 * @param {{id:string,label:string,progress:object,hasEval:boolean}[]} items
 * @param {{silent?:Object<string,number>, ready?:Object<string,number>}} state
 */
export function decideWatch(items, state = {}, now = Date.now()) {
  const silent = { ...(state.silent || {}) };
  const ready = { ...(state.ready || {}) };
  const actions = [];
  for (const it of items) {
    const p = it.progress;
    if (p.silent && silent[it.id] == null) {
      silent[it.id] = now;
      actions.push({ kind: 'silent', id: it.id, label: it.label, staleHours: p.staleHours });
    } else if (!p.silent && silent[it.id] != null) {
      delete silent[it.id];
      actions.push({ kind: 'recovered', id: it.id, label: it.label });
    }
    if (p.ready && ready[it.id] == null) {
      ready[it.id] = now;
      actions.push({ kind: 'ready', id: it.id, label: it.label, hasEval: it.hasEval });
    }
  }
  return { actions, state: { silent, ready } };
}

function readState() {
  try {
    return existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(DIR, { recursive: true });
  const tmp = `${STATE}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE);
}

// Строки логгера и цвет терминала в вердикт не идут.
const clean = (out) => String(out || '')
  // eslint-disable-next-line no-control-regex -- ESC открывает ANSI-цвет
  .replace(/\x1b\[[0-9;]*m/g, '')
  .split('\n')
  .filter((l) => !/\[(INFO|DEBUG|WARN)\]/.test(l))
  .join('\n')
  .trim();

async function evaluate(f, progress) {
  let output, exitCode = 0;
  try {
    const { stdout } = await run(process.execPath, f.evalCommand, { timeout: EVAL_TIMEOUT_MS, maxBuffer: 4 << 20 });
    output = clean(stdout);
  } catch (err) {
    exitCode = err.code ?? 1;
    output = clean(`${err.stdout || ''}\n${err.stderr || err.message}`);
  }
  const rec = { id: f.id, at: new Date().toISOString(), n: progress.n, command: f.evalCommand.join(' '), exitCode, output };
  mkdirSync(DIR, { recursive: true });
  appendFileSync(AUTO_EVALS, JSON.stringify(rec) + '\n');
  return rec;
}

/** Последняя автооценка по каждой гипотезе. */
export function latestAutoEvals() {
  const byId = {};
  for (const r of readJsonl(AUTO_EVALS)) byId[r.id] = r;
  return byId;
}

const fmtHours = (h) => (h == null ? 'ни одной записи' : h >= 48 ? `${Math.round(h / 24)} сут` : `${Math.round(h)} ч`);

/** Один проход сторожа. Можно звать вручную. */
export async function watchForwardsOnce(now = Date.now()) {
  const registry = readRegistry();
  const { running } = classifyHypotheses(registry, FORWARDS, now);
  const items = [];
  for (const f of running) {
    let rows;
    try {
      rows = f.rows() || [];
    } catch {
      continue; // таблицы ещё нет
    }
    items.push({ id: f.id, label: f.label, progress: forwardProgress(f, rows, now), hasEval: !!f.evalCommand, f });
  }

  const { actions, state } = decideWatch(items, readState(), now);
  writeState(state);

  for (const a of actions) {
    if (a.kind === 'silent') {
      await fireNtfy({
        title: `Форвард молчит: ${a.label}`,
        message: `Последняя запись: ${fmtHours(a.staleHours)} назад. Проверь сборщик.`,
        tags: ['warning'],
      });
    } else if (a.kind === 'recovered') {
      await fireNtfy({ title: `Форвард ожил: ${a.label}`, message: 'Сборщик снова пишет.', tags: ['white_check_mark'] });
    } else if (a.kind === 'ready') {
      const it = items.find((x) => x.id === a.id);
      if (!a.hasEval) {
        await fireNtfy({
          title: `Порог взят: ${a.label}`,
          message: 'Стоп-правило выполнено. Скрипта оценки нет — оценить по предзаявке в реестре.',
          tags: ['checkered_flag'],
        });
        continue;
      }
      const rec = await evaluate(it.f, it.progress);
      await fireNtfy({
        title: `Оценка по предзаявке: ${a.label}`,
        message: rec.output.split('\n').slice(-12).join('\n') || `код выхода ${rec.exitCode}`,
        tags: ['checkered_flag'],
      });
    }
  }
  if (actions.length) logger.info(`[ForwardWatch] ${actions.map((a) => `${a.kind}:${a.id}`).join(', ')}`);
  return actions;
}

let timer = null;

export function startForwardWatch() {
  if (timer) return;
  const tick = () => watchForwardsOnce().catch((err) => logger.warn(`[ForwardWatch] проход упал: ${err.message}`));
  setTimeout(tick, 5 * 60_000);
  timer = setInterval(tick, INTERVAL_MS);
}
