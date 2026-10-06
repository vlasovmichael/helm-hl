import { test } from 'node:test';
import assert from 'node:assert/strict';

const { iconName, letterSvg, iconSvg } = await import('../src/modules/dashboard/routes/coinIcon.js');

test('k-монеты ищутся под базовым тикером, остальные как есть', () => {
  assert.equal(iconName('kPEPE'), 'PEPE');
  assert.equal(iconName('BTC'), 'BTC');
  assert.equal(iconName('kaito'), 'kaito');
});

test('буква вместо иконки берётся из базового тикера', () => {
  assert.match(letterSvg('kBONK'), />B<\/text>/);
});

test('страница приложения вместо svg — промах, отдаётся буква', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } });
  try {
    const got = await iconSvg('NOPEICON', 1);
    assert.equal(got.miss, true);
    assert.match(got.svg, />N<\/text>/);
  } finally {
    globalThis.fetch = real;
  }
});

test('найденная иконка кэшируется и не скачивается повторно', async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('<svg xmlns="http://www.w3.org/2000/svg"></svg>', { headers: { 'content-type': 'image/svg+xml' } });
  };
  try {
    await iconSvg('CACHEME', 1);
    const again = await iconSvg('CACHEME', 2);
    assert.equal(again.miss, false);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = real;
  }
});
