#!/usr/bin/env node
//   npm run lab:setup            подключить лабу (новая машина или прод)
//   npm run lab:status           что изменилось в лабе
//   npm run lab:save -- "текст"  сохранить всё из лабы: add, commit, push
//   npm run lab:pull             прод: обновить реестр из hl-lab (cron и deploy.sh)
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim());
const LAB_DIR = join(ROOT, '.lab.git');
const LAB_REMOTE = 'git@github.com:vlasovmichael/hl-lab.git';
const MARKER = '# Лаборатория исследований';

export function labPatterns(gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')) {
  const lines = gitignore.split('\n');
  const start = lines.findIndex((l) => l.startsWith(MARKER));
  if (start === -1) throw new Error(`в .gitignore нет блока «${MARKER}»`);
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') break;
    if (!line.startsWith('#') && line !== '.lab.git/') out.push(line);
  }
  return out;
}

const git = (args, opts = {}) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
const lab = (args, opts) => git([`--git-dir=${LAB_DIR}`, `--work-tree=${ROOT}`, ...args], opts);

// Файлы рабочей копии под путями лабы. `ignored` = по мнению helm-hl, то есть
// всё, что должно жить в лабе; `cached` = то, что helm-hl уже отслеживает.
export function filesUnderLab(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'lab-'));
  const patterns = join(dir, 'patterns');
  writeFileSync(patterns, labPatterns().join('\n') + '\n');
  try {
    const flag = mode === 'cached' ? ['-c', '-i'] : ['-o', '-i'];
    return git(['ls-files', ...flag, `--exclude-from=${patterns}`]).split('\n').filter(Boolean);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function requireLab() {
  if (!existsSync(LAB_DIR)) {
    console.error('❌ Лаба не подключена. Запусти: npm run lab:setup');
    process.exit(1);
  }
}

function setup() {
  if (existsSync(LAB_DIR)) {
    console.log('✅ Лаба уже подключена:', lab(['log', '--oneline', '-1']).trim());
  } else {
    // 🚨 checkout -f перезапишет локальные файлы под путями лабы версией из hl-lab.
    git(['clone', '--bare', '-q', LAB_REMOTE, LAB_DIR], { stdio: 'inherit' });
    lab(['config', 'core.bare', 'false']);
    lab(['config', 'core.worktree', ROOT]);
    lab(['config', 'status.showUntrackedFiles', 'no']);
    lab(['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
    lab(['fetch', '-q', 'origin']);
    lab(['checkout', '-q', '-f', 'main']);
    lab(['branch', '-q', '-u', 'origin/main', 'main']);
    console.log('✅ Лаба подключена:', lab(['log', '--oneline', '-1']).trim());
  }
  git(['config', 'alias.lab', '!git --git-dir="$(git rev-parse --show-toplevel)/.lab.git" --work-tree="$(git rev-parse --show-toplevel)"']);
  console.log('   Команды: npm run lab:status · npm run lab:save -- "что сделал"');
}

function status() {
  requireLab();
  const tracked = new Set(lab(['ls-files']).split('\n').filter(Boolean));
  const changed = lab(['status', '--short']).trim();
  const fresh = filesUnderLab('ignored').filter((f) => !tracked.has(f));
  if (!changed && !fresh.length) return console.log('✅ В лабе всё сохранено.');
  if (changed) console.log('Изменено:\n' + changed);
  if (fresh.length) console.log('Новые файлы:\n' + fresh.map((f) => '?? ' + f).join('\n'));
  console.log('\nСохранить: npm run lab:save -- "что сделал"');
}

function save(message) {
  requireLab();
  const files = filesUnderLab('ignored');
  for (let i = 0; i < files.length; i += 200) lab(['add', '-f', '--', ...files.slice(i, i + 200)]);
  lab(['add', '-u', '-f']);
  try {
    lab(['diff', '--cached', '--quiet']);
    return console.log('✅ Нечего сохранять: лаба и так актуальна.');
  } catch {
    // есть изменения — коммитим ниже
  }
  lab(['commit', '-q', '-m', message || 'лаба: сохранить изменения']);
  lab(['push', '-q', 'origin', 'main'], { stdio: 'inherit' });
  console.log('✅ Сохранено в hl-lab:', lab(['log', '--oneline', '-1']).trim());
}

// Прод читает из лабы только реестр. 🚨 peeks.jsonl рядом пишет сам дашборд —
// его не трогаем; HEAD лабы на проде не двигаем, файл берём из origin/main.
const PULLED = ['data/hypotheses/registry.json'];

function pull() {
  requireLab();
  lab(['fetch', '-q', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  const rev = lab(['rev-parse', '--short', 'origin/main']).trim();
  for (const path of PULLED) {
    const next = lab(['show', `origin/main:${path}`], { maxBuffer: 64 * 1024 * 1024 });
    const full = join(ROOT, path);
    if (existsSync(full) && readFileSync(full, 'utf8') === next) {
      console.log(`✅ ${path} актуален (${rev})`);
      continue;
    }
    const tmp = `${full}.lab-pull.tmp`;
    writeFileSync(tmp, next);
    renameSync(tmp, full);
    console.log(`✅ ${path} обновлён до ${rev}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'setup') setup();
  else if (cmd === 'status') status();
  else if (cmd === 'save') save(rest.join(' '));
  else if (cmd === 'pull') pull();
  else {
    console.error('Команды: setup · status · save "сообщение" · pull');
    process.exit(1);
  }
}
