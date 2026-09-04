// Сторож тика. тик встал на 5 минут (затор весового
// бюджета), /api/health отдавал 503, докер писал unhealthy — и никто не узнал,
// пока это не увидели глазами на дашборде. Здесь — порог, при котором сторож
// обязан заорать, и защита от ложных срабатываний на старте.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { shouldAlertStaleTick } = await import('../src/app/tickWatchdog.js');

const HOUR = 3_600_000;

test('тик молчит дольше 2 минут → тревога', () => {
  assert.equal(
    shouldAlertStaleTick({ tickAgeMs: 130_000, uptimeMs: HOUR, alreadyAlerted: false }),
    true,
  );
});

test('обычный ритм (15с) и разовый ретрай (90с) тревогой не считаются', () => {
  assert.equal(shouldAlertStaleTick({ tickAgeMs: 15_000, uptimeMs: HOUR, alreadyAlerted: false }), false);
  assert.equal(shouldAlertStaleTick({ tickAgeMs: 90_000, uptimeMs: HOUR, alreadyAlerted: false }), false);
});

test('на старте молчим: первый тик законно долгий (universe, свечи, снапшот)', () => {
  assert.equal(
    shouldAlertStaleTick({ tickAgeMs: 150_000, uptimeMs: 160_000, alreadyAlerted: false }),
    false,
  );
});

test('один пуш на эпизод — пока не отпустило, второй раз не звоним', () => {
  assert.equal(
    shouldAlertStaleTick({ tickAgeMs: 600_000, uptimeMs: HOUR, alreadyAlerted: true }),
    false,
  );
});
