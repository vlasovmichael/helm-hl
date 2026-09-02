import { config } from '../core/config.js';
import { fetchPositions, KNOWN_BUILDER_DEXES } from './winnersPositions.js';

// ─────────────────────────────────────────────────
//  builderPositions — свои позиции на builder-DEX'ах (HIP-3)
// ─────────────────────────────────────────────────
// У HL кроме основного перп-DEX'а есть площадки HIP-3 (xyz с акциями и
// товарами, flx, vntl, hyna, km, abcd, cash, para, mkts). Без параметра `dex`
// их позиции в clearinghouseState НЕ приходят — из-за этого дашборд показывал
// пустой экран, когда весь счёт стоял на xyz.
//
// 🚨 Только ЧТЕНИЕ и только отдельным блоком. Подмешивать это в
// getPositionsCached нельзя: оттуда читает нянька, а executor не умеет
// адресовать активы builder-DEX'ов — усыновлённая позиция получила бы стоп в
// никуда. Пока такие позиции ведутся руками, и панель обязана говорить это
// прямым текстом, а не молчать.
//
// Маржа на каждой площадке своя и изолированная, поэтому эквити считается
// отдельно и в дневной стоп-лосс бота не входит.

const TTL_MS = 30_000;
let cache = { payload: null, at: 0, inflight: null };

async function build() {
  // Фолбэк обязателен: список площадок читается из userFills (вес 20), и у
  // живого бота этот запрос на LOW-приоритете часто не пролезает в бюджет.
  // Без фолбэка отказ молча выглядел бы как «на builder-DEX'ах ничего нет».
  const snap = await fetchPositions(config.wallet.address, {
    fallbackDexes: KNOWN_BUILDER_DEXES,
  });
  // Основной DEX уже показан обычной панелью — здесь только площадки HIP-3.
  const positions = (snap.positions || []).filter((p) => p.dex && p.dex !== 'main');
  const venues = (snap.venues || []).filter((v) => v.dex && v.dex !== 'main');
  return {
    positions,
    venues,
    equity: venues.reduce((s, v) => s + (Number.isFinite(v.equity) ? v.equity : 0), 0),
    unrealizedPnl: positions.reduce((s, p) => s + p.unrealizedPnl, 0),
    notional: positions.reduce((s, p) => s + p.sizeUsd, 0),
    // true = список площадок прочитать не успели, смотрели не везде.
    partial: Boolean(snap.partial),
  };
}

/** Позиции на HIP-3 площадках. Бросает — вызывающий обязан пережить отказ. */
export async function getBuilderPositions() {
  const now = Date.now();
  if (cache.payload && now - cache.at < TTL_MS) return cache.payload;
  if (cache.inflight) return cache.inflight;
  cache.inflight = build();
  try {
    const payload = await cache.inflight;
    cache = { payload, at: Date.now(), inflight: null };
    return payload;
  } catch (err) {
    cache.inflight = null;
    throw err;
  }
}
