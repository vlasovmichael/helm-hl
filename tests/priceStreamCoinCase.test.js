// Регистр имени монеты в подписке дашборда на цены.
//
// Why (04.09.2026): «цена дёргается». Причина оказалась жёстче, чем выглядела:
// подписка на несуществующий тикер не игнорируется биржей и не даёт ошибку —
// она РВЁТ СОКЕТ (close 1006). Одна k-монета в позициях (`kPEPE`, которую фронт
// приводил к `KPEPE`) убивала поток цен по ВСЕМ монетам, дальше reconnect слал
// то же неверное имя, и цена жила вспышками между разрывами.
//
// Проверяем ровно то, что уходит наружу: имя от сервера не искажается, а ключ
// карт остаётся каноническим — чтение цены не должно зависеть от того, каким
// регистром монету назвал вызывающий.
//
// Запуск: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Модуль браузерный: до startPriceStream() он не трогает ни DOM, ни сокет.
const sent = [];
class FakeWebSocket {
  static OPEN = 1;
  constructor() {
    this.readyState = 1;
    FakeWebSocket.last = this;
  }
  send(raw) { sent.push(JSON.parse(raw)); }
  close() {}
}
globalThis.WebSocket = FakeWebSocket;
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
globalThis.window = { addEventListener() {} };
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { startPriceStream, setWatchedCoins, coinKey } =
  await import('../src/modules/dashboard/web/src/net/priceStream.js');

startPriceStream();
FakeWebSocket.last.onopen?.();

test('на биржу уходит имя монеты ровно как его дал сервер', () => {
  sent.length = 0;
  setWatchedCoins(['kPEPE', 'BTC', 'xyz:NOK']);
  const subscribed = sent
    .filter((m) => m.method === 'subscribe')
    .map((m) => m.subscription.coin);
  assert.deepEqual(
    subscribed.sort(), ['BTC', 'kPEPE', 'xyz:NOK'],
    'искажённый тикер рвёт сокет и гасит цены по всем монетам сразу',
  );
});

test('ключ карт канонический — чтение не зависит от регистра вызывающего', () => {
  assert.equal(coinKey('kPEPE'), coinKey('KPEPE'));
  assert.equal(coinKey('kPEPE'), 'KPEPE');
  // HIP-3: префикс площадки строчный, тикер после разделителя — верхний.
  assert.equal(coinKey('XYZ:nok'), 'xyz:NOK');
});

test('отписка идёт тем же именем, что и подписка', () => {
  setWatchedCoins(['kPEPE']);
  sent.length = 0;
  setWatchedCoins([]);
  const unsub = sent.filter((m) => m.method === 'unsubscribe').map((m) => m.subscription.coin);
  assert.deepEqual(unsub, ['kPEPE']);
});
