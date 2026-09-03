// Тесты healthWatch — решение «звонить или молчать» по состоянию реестра.
//
// Запуск: npm test
//
// Кейсы:
//  - boot grace: на старте молчим при любом состоянии
//  - одиночное красное не будит (нужно подтверждение подряд)
//  - подтверждённое красное → alert, повторно не звонит
//  - warn не считается аварией
//  - выздоровление шлёт ровно один пуш
//  - 'unknown' не считается выздоровлением

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PUBLIC_WALLET_ADDRESS = '0x0000000000000000000000000000000000000000';

const { decideHealthAlert } = await import('../src/app/healthWatch.js');

const UP = 10 * 60_000; // аптайм заведомо больше boot-grace

test('на старте молчим даже при аварии', () => {
  assert.equal(
    decideHealthAlert({ overall: 'stale', streak: 99, alreadyAlerted: false, uptimeMs: 1000 }),
    'none',
  );
});

test('одиночное красное не будит телефон', () => {
  assert.equal(
    decideHealthAlert({ overall: 'stale', streak: 1, alreadyAlerted: false, uptimeMs: UP }),
    'none',
  );
  assert.equal(
    decideHealthAlert({ overall: 'drift', streak: 2, alreadyAlerted: false, uptimeMs: UP }),
    'none',
  );
});

test('подтверждённое красное → alert', () => {
  for (const overall of ['stale', 'drift', 'fail']) {
    assert.equal(
      decideHealthAlert({ overall, streak: 3, alreadyAlerted: false, uptimeMs: UP }),
      'alert',
      overall,
    );
  }
});

test('один пуш на эпизод: пока алерт активен — молчим', () => {
  assert.equal(
    decideHealthAlert({ overall: 'stale', streak: 50, alreadyAlerted: true, uptimeMs: UP }),
    'none',
  );
});

test('warn не авария', () => {
  assert.equal(
    decideHealthAlert({ overall: 'warn', streak: 10, alreadyAlerted: false, uptimeMs: UP }),
    'none',
  );
});

test('unknown не авария и не выздоровление', () => {
  assert.equal(
    decideHealthAlert({ overall: 'unknown', streak: 10, alreadyAlerted: false, uptimeMs: UP }),
    'none',
  );
  // Реестр замолчал во время эпизода — это не «починилось».
  assert.equal(
    decideHealthAlert({ overall: 'unknown', streak: 0, alreadyAlerted: true, uptimeMs: UP }),
    'none',
  );
});

test('выздоровление после эпизода', () => {
  assert.equal(
    decideHealthAlert({ overall: 'ok', streak: 0, alreadyAlerted: true, uptimeMs: UP }),
    'recover',
  );
  // warn — тоже измеренное состояние, эпизод закрываем.
  assert.equal(
    decideHealthAlert({ overall: 'warn', streak: 0, alreadyAlerted: true, uptimeMs: UP }),
    'recover',
  );
});

test('без эпизода выздоровления не бывает', () => {
  assert.equal(
    decideHealthAlert({ overall: 'ok', streak: 0, alreadyAlerted: false, uptimeMs: UP }),
    'none',
  );
});
