// Режим наблюдения: конфиг читается один раз при импорте, поэтому каждый случай в своём процессе.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WALLET = '0x0000000000000000000000000000000000000000';
const CONFIG = new URL('../src/core/config.js', import.meta.url).href;
const EXCHANGE = new URL('../src/modules/exchange.js', import.meta.url).href;
const NTFY = new URL('../src/core/ntfy.js', import.meta.url).href;
const NOTIFY_LOG = new URL('../src/core/notifyLog.js', import.meta.url).href;

function runIn(env, script, cwd) {
  const { NODE_ENV: _ignored, ...parent } = process.env;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...parent, PUBLIC_WALLET_ADDRESS: WALLET, HL_PRIVATE_KEY: '', HL_AGENT_PRIVATE_KEY: '', ...env },
    encoding: 'utf8',
    cwd,
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout.trim() };
}

const DUMP_CONFIG = `
  const { config } = await import(${JSON.stringify(CONFIG)});
  console.log(JSON.stringify({
    mode: config.mode,
    production: config.isProduction,
    agentKey: config.wallet.agentPrivateKey,
    mainKey: config.wallet.privateKey,
    adopt: config.trading.adoptEnabled,
    paper: config.trading.manualPaperAdoptEnabled,
    signals: config.trading.tgSignalEnabled,
    ntfy: config.ntfy.url,
  }));
`;

test('без режима наблюдения бот без ключа не стартует', () => {
  const { status, stderr } = runIn({ OBSERVE_ONLY: 'false' }, DUMP_CONFIG);
  assert.notEqual(status, 0);
  assert.match(stderr, /Refusing to start/);
});

test('ключи и флаги торговли игнорируются, даже если заданы', () => {
  const { status, stdout } = runIn({
    OBSERVE_ONLY: 'true',
    HL_AGENT_PRIVATE_KEY: '0xagent',
    HL_PRIVATE_KEY: '0xmain',
    ADOPT_ENABLED: 'true',
    MANUAL_PAPER_ADOPT_ENABLED: 'true',
    TG_SIGNAL_ENABLED: 'true',
  }, DUMP_CONFIG);
  assert.equal(status, 0);
  const seen = JSON.parse(stdout);
  assert.equal(seen.mode, 'OBSERVE');
  assert.equal(seen.agentKey, null);
  assert.equal(seen.mainKey, null);
  assert.equal(seen.adopt, false);
  assert.equal(seen.paper, false);
  assert.equal(seen.signals, false);
});

test('все подписанные запросы падают до обращения к SDK', () => {
  const { status, stdout, stderr } = runIn({ OBSERVE_ONLY: 'true' }, `
    const exchange = await import(${JSON.stringify(EXCHANGE)});
    const calls = {
      openMarket: () => exchange.openMarket('BTC', true, 1, 0.01),
      closeMarket: () => exchange.closeMarket('BTC', 1, 0.01),
      placeTrigger: () => exchange.placeTrigger({ coin: 'BTC', isBuy: false, sz: 1, px: 1, tpsl: 'sl' }),
      placeLimit: () => exchange.placeLimit({ coin: 'BTC', isBuy: false, sz: 1, px: 1 }),
      cancelOrderFor: () => exchange.cancelOrderFor('BTC', 1),
    };
    for (const [name, call] of Object.entries(calls)) {
      try { await call(); console.log(name + ':passed'); }
      catch (err) { console.log(name + ':' + (err.message.includes('observe-only') ? 'blocked' : err.message)); }
    }
  `);
  assert.equal(status, 0, stderr);
  // Логгер пишет в тот же stdout: остаются только строки проверки.
  assert.deepEqual(stdout.split('\n').filter((line) => !line.startsWith('{')), [
    'openMarket:blocked', 'closeMarket:blocked', 'placeTrigger:blocked', 'placeLimit:blocked', 'cancelOrderFor:blocked',
  ]);
});

test('NTFY_ENABLED=false оставляет отправителей без адреса, по умолчанию адрес есть', () => {
  const off = JSON.parse(runIn({ OBSERVE_ONLY: 'true', NTFY_ENABLED: 'false', NTFY_URL: 'http://ntfy:80' }, DUMP_CONFIG).stdout);
  assert.equal(off.ntfy, '');
  const on = JSON.parse(runIn({ OBSERVE_ONLY: 'true', NTFY_URL: 'http://ntfy:80' }, DUMP_CONFIG).stdout);
  assert.equal(on.ntfy, 'http://ntfy:80');
});

// Журнал пишется в data/ рабочей папки: запуск из корня испортил бы настоящий журнал.
function fireAlert(env) {
  const cwd = mkdtempSync(join(tmpdir(), 'bell-only-'));
  mkdirSync(join(cwd, 'data'));
  try {
    const { status, stdout, stderr } = runIn({ OBSERVE_ONLY: 'true', NTFY_URL: 'http://127.0.0.1:9', ...env }, `
      const { config } = await import(${JSON.stringify(CONFIG)});
      const { fireNtfy } = await import(${JSON.stringify(NTFY)});
      const { getNotifications } = await import(${JSON.stringify(NOTIFY_LOG)});
      const fired = await fireNtfy({ title: 'alert', message: 'body', urgent: true });
      console.log('RESULT' + JSON.stringify({ fired, url: config.ntfy.url, bell: getNotifications(10) }));
    `, cwd);
    assert.equal(status, 0, stderr);
    return JSON.parse(stdout.split('\n').find((line) => line.startsWith('RESULT')).slice('RESULT'.length));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test('NTFY_BELL_ONLY пишет алерт в колокольчик и оставляет телефон без адреса', () => {
  for (const enabled of ['true', 'false']) {
    const seen = fireAlert({ NTFY_ENABLED: enabled, NTFY_BELL_ONLY: 'true' });
    assert.equal(seen.fired, true);
    assert.equal(seen.url, '');
    assert.equal(seen.bell.length, 1);
    assert.equal(seen.bell[0].title, 'alert');
    assert.equal(seen.bell[0].emailed, false);
  }
});

test('без NTFY_BELL_ONLY выключенный ntfy не пишет в колокольчик', () => {
  const seen = fireAlert({ NTFY_ENABLED: 'false' });
  assert.equal(seen.fired, false);
  assert.deepEqual(seen.bell, []);
});
