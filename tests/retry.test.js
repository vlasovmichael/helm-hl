import { test } from 'node:test';
import assert from 'node:assert/strict';

const { retryWithBackoff } = await import('../src/core/retry.js');
const { logger } = await import('../src/core/logger.js');

test('retry: возвращает первый успешный результат без повтора', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls++;
    return 'ok';
  }, { baseDelayMs: 0 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('retry: повторяет транзиентную сетевую ошибку и возвращает результат', async () => {
  let calls = 0;
  const result = await retryWithBackoff(async () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    return 42;
  }, { maxRetries: 3, baseDelayMs: 0, maxDelayMs: 0, quiet: true });
  assert.equal(result, 42);
  assert.equal(calls, 3);
});

test('retry: не повторяет клиентскую, весовую и неизвестную ошибки', async () => {
  for (const error of [
    Object.assign(new Error('bad request'), { response: { status: 400 } }),
    Object.assign(new Error('weight'), { isWeightTimeout: true }),
    new Error('business rule'),
  ]) {
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(async () => { calls++; throw error; }, { maxRetries: 4, baseDelayMs: 0, quiet: true }),
      error,
    );
    assert.equal(calls, 1);
  }
});

test('retry: повторяет HTTP 429 и 5xx, включая status без response', async () => {
  for (const error of [
    Object.assign(new Error('limited'), { response: { status: 429, headers: { 'retry-after': '0' } } }),
    Object.assign(new Error('bad gateway'), { response: { status: 502 } }),
    Object.assign(new Error('unavailable'), { status: 503 }),
  ]) {
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(async () => { calls++; throw error; }, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0, quiet: true }),
      error,
    );
    assert.equal(calls, 2);
  }
});

test('retry: распознаёт сетевые таймауты и специальные транзиентные сообщения', async () => {
  for (const error of [
    Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }),
    Object.assign(new Error('headers'), { code: 'UND_ERR_HEADERS_TIMEOUT' }),
    new Error('possibly indexer lag'),
    new Error('An unknown error occurred upstream'),
  ]) {
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(async () => { calls++; throw error; }, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0, quiet: true }),
      error,
    );
    assert.equal(calls, 2);
  }
});

test('retry: соблюдает backoff, Retry-After, потолок, jitter и пишет наблюдаемую диагностику', async () => {
  const originalTimeout = globalThis.setTimeout;
  const originalRandom = Math.random;
  const original = { warn: logger.warn, error: logger.error, debug: logger.debug };
  const delays = [];
  const logs = [];
  globalThis.setTimeout = (fn, ms) => { delays.push(ms); queueMicrotask(fn); return 1; };
  Math.random = () => 1;
  logger.warn = (message) => logs.push(['warn', message]);
  logger.error = (message) => logs.push(['error', message]);
  logger.debug = (message) => logs.push(['debug', message]);
  try {
    let calls = 0;
    await assert.rejects(
      retryWithBackoff(async () => {
        calls++;
        throw Object.assign(new Error('limited'), { response: { status: 429, headers: { 'retry-after': '2' } } });
      }, { maxRetries: 3, baseDelayMs: 100, maxDelayMs: 3_000, label: 'orders' }),
    );
    assert.equal(calls, 3);
    assert.deepEqual(delays, [2_400, 2_400]);
    assert.match(logs[0][1], /^\[Retry:orders\] Attempt 1\/3 failed: limited — retrying in 2400ms/);
    assert.match(logs.at(-1)[1], /All 3 attempts failed/);

    delays.length = 0;
    calls = 0;
    Math.random = () => 0;
    await assert.rejects(retryWithBackoff(async () => {
      calls++;
      throw Object.assign(new Error('gateway'), { response: { status: 500 } });
    }, { maxRetries: 2, baseDelayMs: 2_000, maxDelayMs: 1_000, quiet: true }));
    assert.equal(calls, 2);
    assert.deepEqual(delays, [800]);
    assert.equal(logs.at(-1)[0], 'debug');
  } finally {
    globalThis.setTimeout = originalTimeout;
    Math.random = originalRandom;
    Object.assign(logger, original);
  }
});

test('retry: каждый перечисленный код сети действительно ретраится', async () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'ENETUNREACH', 'EPIPE', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']) {
    let calls = 0;
    await assert.rejects(retryWithBackoff(async () => {
      calls++;
      throw Object.assign(new Error(code), { code });
    }, { maxRetries: 2, baseDelayMs: 0, maxDelayMs: 0, quiet: true }));
    assert.equal(calls, 2, code);
  }
});
