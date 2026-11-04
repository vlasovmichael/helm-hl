// Сообщение Kafka из сделки биржи: ключ, поля, отказ на неполном кадре.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { toKafkaMessage } = await import('../src/core/kafkaTrades.js');

const TRADE = {
  coin: 'BTC', side: 'B', px: '100000.5', sz: '0.01', time: 1_700_000_000_000, tid: 42,
  hash: '0xabc', users: ['0x1', '0x2'],
};

test('ключ — монета, время сделки — timestamp, адреса участников не едут', () => {
  const message = toKafkaMessage(TRADE);
  assert.equal(message.key, 'BTC');
  assert.equal(message.timestamp, '1700000000000');
  assert.deepEqual(JSON.parse(message.value), {
    coin: 'BTC', side: 'buy', px: '100000.5', sz: '0.01', time: 1_700_000_000_000, tid: 42,
  });
});

test('сторона A — продажа', () => {
  assert.equal(JSON.parse(toKafkaMessage({ ...TRADE, side: 'A' }).value).side, 'sell');
});

test('неполный кадр не публикуется', () => {
  assert.equal(toKafkaMessage(null), null);
  assert.equal(toKafkaMessage({ ...TRADE, side: 'X' }), null);
  assert.equal(toKafkaMessage({ ...TRADE, px: 100000.5 }), null);
  assert.equal(toKafkaMessage({ ...TRADE, tid: undefined }), null);
  assert.equal(toKafkaMessage({ ...TRADE, coin: undefined }), null);
});
