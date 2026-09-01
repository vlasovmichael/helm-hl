// ─────────────────────────────────────────────────
//  winnersWatch — пуш «Гении Уолл-стрит» открыли/закрыли позу
// ─────────────────────────────────────────────────
// Опрашивает открытые позиции трёх замороженных адресов
// (docs/winners-preregistration.json) и шлёт ntfy + колокольчик, когда позиция
// ПОЯВИЛАСЬ или ИСЧЕЗЛА. Витрина на /lab показывает то же самое, но только пока
// открыта вкладка — здесь то же чтение по таймеру, чтобы не сидеть у экрана.
//
// ⛔ Наблюдение, а не участие. Предзаявленный тест считает вердикт только по
// tools/winners.mjs track на снимках лидерборда, дата решения 10.11.2026.
// Ни один пуш отсюда в этот расчёт не входит и входить не должен: список
// заморожен 13.08, и подглядывание за ним ничего в нём не меняет.
//
// Что здесь СОБЫТИЕ. Только переходы flat→открыто и открыто→flat, плюс разворот
// стороны (он же закрытие + открытие). Доборы и частичные фиксации молчат:
// замер 30.08 показал на активном адресе 646 филлов в сутки против 4.3 смен
// состояния позиции — по филлам это была бы не сигнализация, а шум.
//
// Что здесь НЕ сигнал на вход. Данные приходят из СОСТОЯНИЯ счёта, а не из
// филла: между их сделкой и пушем проходит до одного интервала опроса, и цена
// в пуше — их вход, а не тот, что достанется при повторе.
//
// Вес: 3 адреса × ~2-3 DEX'а × clearinghouseState (2 единицы) ≈ 18/мин при
// LOW-доле бюджета в 700. Приоритет LOW, живой бот в очереди всегда впереди.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../core/logger.js';
import { fireNtfy } from '../core/ntfy.js';
import { fetchPositions } from './winnersPositions.js';
import { appendEvents } from './winnersJournal.js';
import { hlInfo, HL_PRIORITY } from '../core/hlClient.js';

const ENABLED =
  (process.env.WINNERS_WATCH_ENABLED || 'true').toLowerCase() === 'true';
const INTERVAL_MS =
  parseFloat(process.env.WINNERS_WATCH_INTERVAL_SEC || '60') * 1_000;
// Мелочь на сдачу счёта отсекаем: у адреса с $170k эквити позиция в пару
// десятков долларов — это пыль после закрытия, а не решение.
const MIN_NOTIONAL_USD =
  parseFloat(process.env.WINNERS_WATCH_MIN_USD || '500');

const FREEZE_FILE = join('docs', 'winners-preregistration.json');
const STATE_FILE = join('data', 'winners-watch.json');

let timer = null;
/** address → { key → snapshot }. Наличие ключа = адрес уже видели. */
let known = new Map();

// ── состояние на диске ──
// Пережить рестарт обязательно: без файла бот после каждого деплоя считал бы
// все открытые позиции «только что открытыми» и выдавал залп пушей.
function loadState() {
  try {
    if (!existsSync(STATE_FILE)) return;
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    known = new Map(Object.entries(raw.addresses || {}).map(([a, m]) => [a, new Map(Object.entries(m))]));
  } catch (err) {
    logger.warn(`[WinnersWatch] state read failed: ${err.message}`);
  }
}

function saveState() {
  try {
    mkdirSync('data', { recursive: true });
    const addresses = {};
    for (const [addr, m] of known) addresses[addr] = Object.fromEntries(m);
    writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: Date.now(), addresses }, null, 1));
  } catch (err) {
    logger.warn(`[WinnersWatch] state write failed: ${err.message}`);
  }
}

function addresses() {
  if (!existsSync(FREEZE_FILE)) return [];
  try {
    return JSON.parse(readFileSync(FREEZE_FILE, 'utf8')).selected.map((s) => s.address);
  } catch (err) {
    logger.warn(`[WinnersWatch] freeze file unreadable: ${err.message}`);
    return [];
  }
}

// ── форматирование ──
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n) =>
  Math.abs(n) >= 1000 ? `$${(n / 1000).toFixed(1)}k` : `$${n.toFixed(0)}`;
const arrow = (side) => (side === 'SHORT' ? '▼' : '▲');
const dur = (ms) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}м`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}ч` : `${Math.round(h / 24)}д`;
};

// coin у HL уже несёт префикс площадки («xyz:GME»), поэтому в подписи он берётся
// как есть — dex отдельно нужен только чтобы ключ не схлопнул одинаковый тикер
// на двух площадках.
function snapshotOf(p, since) {
  // since = когда позиция впервые попала в срез. Точность — интервал опроса;
  // для «держал 4 дня» этого хватает, а для «вошёл по такой-то цене» есть
  // entryPrice от самой биржи.
  return { coin: p.coin, side: p.side, sizeUsd: p.sizeUsd, entryPrice: p.entryPrice, leverage: p.leverage, since };
}

// ── исход закрытия ──
// Пуш «× CLOSE QNT · был $5.0k» не отвечает на единственный вопрос, который
// про чужую сделку и задают: он на этом заработал или потерял? Состояние счёта
// ответа не содержит — закрытой позиции в нём уже нет. Считаем по филлам:
// closedPnl биржа проставляет сама, комиссию вычитаем (у нас 100% тейкер, и на
// тонких сделках она и есть весь результат).
//
// Вес userFillsByTime — 20 против 2 у clearinghouseState, поэтому запрос идёт
// ТОЛЬКО когда в тике действительно что-то закрылось (≈4 раза в сутки на
// адрес), и один на адрес, а не на монету.
const CLOSE_LOOKBACK_MS = 30 * 60_000;

async function closedPnlFor(address, coins) {
  const out = new Map();
  if (!coins.size) return out;
  let fills;
  try {
    fills = await hlInfo(
      { type: 'userFillsByTime', user: address, startTime: Date.now() - CLOSE_LOOKBACK_MS, aggregateByTime: true },
      { label: 'winners/closedPnl', timeoutMs: 8_000, maxRetries: 1, priority: HL_PRIORITY.LOW },
    );
  } catch (err) {
    // Исход не дождался бюджета — пишем событие без него. Пустой pnl честнее
    // нуля: «не знаем» и «вышел в ноль» это разные вещи.
    logger.debug(`[WinnersWatch] ${short(address)}: closedPnl пропущен (${err.message})`);
    return out;
  }
  for (const f of Array.isArray(fills) ? fills : []) {
    if (!coins.has(f?.coin)) continue;
    const pnl = parseFloat(f.closedPnl ?? '0');
    const fee = parseFloat(f.fee ?? '0');
    if (!Number.isFinite(pnl)) continue;
    const cur = out.get(f.coin) || { pnl: 0, fee: 0, fills: 0 };
    cur.pnl += pnl;
    cur.fee += Number.isFinite(fee) ? fee : 0;
    cur.fills++;
    out.set(f.coin, cur);
  }
  return out;
}

/**
 * Сравнивает прошлый и текущий срез одного адреса.
 * @returns {Array<{kind:'open'|'close'|'flip', ticker:string, ...}>}
 */
export function diff(prev, next) {
  const events = [];
  for (const [key, cur] of next) {
    const was = prev.get(key);
    if (!was) events.push({ kind: 'open', key, ...cur });
    else if (was.side !== cur.side) events.push({ kind: 'flip', key, from: was.side, ...cur });
  }
  for (const [key, was] of prev) {
    if (!next.has(key)) events.push({ kind: 'close', key, ...was });
  }
  return events;
}

async function tick() {
  const list = addresses();
  if (!list.length) return;

  let changed = false;
  const lines = [];
  const journal = [];

  // По одному, а не залпом: три параллельных запроса конкурируют за один и тот
  // же LOW-бюджет и валят друг друга по дедлайну.
  for (const address of list) {
    let account;
    try {
      account = await fetchPositions(address);
    } catch (err) {
      // 🚨 Отказ по бюджету НЕ значит «позиций нет». Диффать нечего: пустой
      // ответ прочитался бы как закрытие всего, что у человека открыто, и
      // выдал бы залп ложных пушей. Пропускаем адрес до следующего тика.
      logger.debug(`[WinnersWatch] ${short(address)}: ${err.message}`);
      continue;
    }
    // Тот же довод про частичный ответ: список DEX'ов не дочитан ⇒ часть
    // площадок не опрошена ⇒ их позиции выглядят закрытыми.
    if (account.partial) {
      logger.debug(`[WinnersWatch] ${short(address)}: неполный обход DEX'ов, дифф пропущен`);
      continue;
    }

    // Первый удачный ответ по адресу запоминаем МОЛЧА, иначе всё, что у него уже
    // открыто, приехало бы пушем «только что открыл». Отметка ведётся отдельно
    // по каждому адресу: один упавший на первом тике не должен пропустить свой
    // засев из-за того, что двум другим повезло.
    const first = !known.has(address);
    const prev = known.get(address) || new Map();

    const now = Date.now();
    const next = new Map(
      account.positions
        .filter((p) => p.sizeUsd >= MIN_NOTIONAL_USD)
        .map((p) => {
          const key = `${p.dex}|${p.coin}`;
          const was = prev.get(key);
          // Возраст позиции переносим, пока сторона не менялась: доборы её не
          // обнуляют, разворот — обнуляет (это уже другая сделка).
          const since = was && was.side === p.side ? (was.since ?? now) : now;
          return [key, snapshotOf(p, since)];
        }),
    );
    known.set(address, next);
    changed = true;
    if (first) {
      logger.info(`[WinnersWatch] ${short(address)}: исходный срез (${next.size} поз.) запомнен молча`);
      continue;
    }

    const events = diff(prev, next);
    if (!events.length) continue;

    // Исход тянем одним запросом на адрес и только если что-то закрылось.
    const closedCoins = new Set(events.filter((e) => e.kind !== 'open').map((e) => e.coin));
    const outcomes = await closedPnlFor(address, closedCoins);

    for (const ev of events) {
      const t = ev.coin;
      const res = outcomes.get(t);
      const pnlNet = res ? res.pnl - res.fee : null;
      // held считаем только от нашего же наблюдения: если позиция была открыта
      // ещё до того, как сторож её увидел, since = момент первого среза, и
      // возраст занижен. Помечаем это флагом, а не молчим.
      const heldMs = ev.since ? now - ev.since : null;

      if (ev.kind === 'open')
        lines.push(`${arrow(ev.side)} OPEN ${t} ${ev.side} · ${usd(ev.sizeUsd)}${ev.leverage ? ` · ${ev.leverage}×` : ''} · ${short(address)}`);
      else if (ev.kind === 'close')
        lines.push(`× CLOSE ${t} ${ev.side} · был ${usd(ev.sizeUsd)}${pnlNet == null ? '' : ` · ${pnlNet >= 0 ? '+' : ''}${usd(pnlNet)}`}${heldMs ? ` · ${dur(heldMs)}` : ''} · ${short(address)}`);
      else
        lines.push(`⇄ FLIP ${t} ${ev.from}→${ev.side} · ${usd(ev.sizeUsd)}${pnlNet == null ? '' : ` · ${pnlNet >= 0 ? '+' : ''}${usd(pnlNet)}`} · ${short(address)}`);

      journal.push({
        ts: now,
        address,
        kind: ev.kind,
        coin: t,
        dex: ev.key.split('|')[0],
        side: ev.side,
        from: ev.from ?? null,
        sizeUsd: Math.round(ev.sizeUsd),
        entryPrice: ev.entryPrice ?? null,
        leverage: ev.leverage ?? null,
        pnlNet: pnlNet == null ? null : Math.round(pnlNet * 100) / 100,
        pnlGross: res ? Math.round(res.pnl * 100) / 100 : null,
        fee: res ? Math.round(res.fee * 100) / 100 : null,
        heldMs,
        heldFromFirstSight: ev.kind !== 'open' ? true : undefined,
      });
    }
  }

  appendEvents(journal);

  if (changed) saveState();
  if (!lines.length) return;

  // Разом «открылось» больше десятка — это почти наверняка не решение человека,
  // а перекос на нашей стороне (адрес перевёл маржу, площадка отдала иной срез).
  // Режем письмо, а не разбираемся в пуше.
  const MAX_LINES = 12;
  const extra = lines.length - MAX_LINES;
  const body = extra > 0 ? [...lines.slice(0, MAX_LINES), `…и ещё ${extra}`] : lines;

  // priority 2 = холодный пуш: телефон не звенит, мгновенное письмо не уходит
  // (порог instant-почты — 3), событие копится в дайджесте и колокольчике.
  // Это наблюдение за чужим счётом, а не риск по нашим деньгам.
  await fireNtfy({
    title: `Гении Уолл-стрит · ${lines.length} ${lines.length === 1 ? 'событие' : 'событий'}`,
    message: `${body.join('\n')}\n\nЧужие входы, видны постфактум. Не сигнал.`,
    tags: ['eyes'],
    priority: 2,
  });
  logger.info(`[WinnersWatch] ${lines.length} событий отправлено`);
}

/** Запускает сторож. Fail-soft: ошибки тика не валят бота. */
export function startWinnersWatch() {
  if (!ENABLED) {
    logger.info('[WinnersWatch] disabled (WINNERS_WATCH_ENABLED=false)');
    return null;
  }
  if (!existsSync(FREEZE_FILE)) {
    logger.info('[WinnersWatch] список не заморожен — сторож не поднят');
    return null;
  }
  loadState();
  const run = () =>
    tick().catch((err) => logger.warn(`[WinnersWatch] tick failed: ${err.message}`));
  timer = setInterval(run, INTERVAL_MS);
  if (timer.unref) timer.unref();
  run();
  logger.info(
    `[WinnersWatch] сторож поднят: ${addresses().length} адреса, каждые ${INTERVAL_MS / 1000}с` +
      `${known.size ? '' : ' (первый тик — молча, только запоминает)'}`,
  );
  return () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
}
