// ─────────────────────────────────────────────────
//  Разбор постов сигнальных TG-каналов → {монета, сторона, время}
// ─────────────────────────────────────────────────
// Вход/цели/стоп канала игнорируются: мерим прогноз, а не рисованную геометрию.
//
// 🚨 Пост-отчёт цитирует исходный сигнал целиком — без RESULT_MARKERS один
// прогноз открывал бы позу дважды, второй раз уже зная исход.
//
// Чистый модуль: ни сети, ни БД, ни config.

/**
 * HTML-сущности в текст. Превью t.me отдаёт `$` как `&#036;`, и без раскодировки
 * «COIN: &#036;ADA/USDT» мимо любого разумного шаблона. Правится здесь, а не в
 * выгрузке: архивы уже лежат с сущностями.
 */
function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(Number(c)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

/** Маркеры поста-отчёта. Есть хоть один → это витрина, не сигнал. */
const RESULT_MARKERS = [
  /all targets? achieved/i,
  /targets? \d*\s*(hit|achieved|reached)/i,
  /\bprofit\s*:/i,
  /\d+(?:\.\d+)?%\s*(?:profit|gain|loss)/i,
  /\bperiod\s*:\s*\d/i,
  /stop\s*-?loss\s+hit/i,
  /\bstepped out\b/i,
  /\b(?:up|down)\s+\d+(?:\.\d+)?%\s*so far/i,
  /\bdelivered\b/i,
  /✅|❌/,
];

/**
 * Тикер поста → тикер Hyperliquid.
 * Снимает котируемую валюту и хвост перпа, «1000PEPE» приводит к k-нотации
 * (на HL это kPEPE — строчная k, см. kcoin_api_naming).
 * @param {string} raw
 * @returns {string|null}
 */
export function normalizeCoin(raw) {
  if (!raw) return null;
  let c = String(raw).trim().toUpperCase().replace(/^[#$]/, '');
  c = c.replace(/[/-]?(USDT|USDC|USD|PERP)$/i, '');
  if (!/^[A-Z0-9]{2,12}$/.test(c)) return null;
  const k = c.match(/^1000(?:X)?([A-Z]{2,10})$/);
  if (k) return `k${k[1]}`;
  return c;
}

/** Слово стороны → 'long' | 'short' | null. */
function normalizeSide(word) {
  if (!word) return null;
  const w = String(word).toUpperCase();
  if (/^(LONG|BUY|BUYING|BULLISH)$/.test(w)) return 'long';
  if (/^(SHORT|SELL|SELLING|SHORTING|BEARISH)$/.test(w)) return 'short';
  return null;
}

// ── Каналы ──────────────────────────────────────────────────────────────────
// `match` возвращает {coin, side} или null. Разбор строгий намеренно: пропущенный
// сигнал стоит одной сделки, а выдуманный отравляет весь замер.
const CHANNELS = [
  {
    // #KITE/USDT ⏎ #LONG ⏎ ENTRY: … — единственный формат с обеими сторонами
    // и внятной частотой (1.4 сигнала в день на выгрузке за август).
    name: 'cryptoclubpumps',
    match(text) {
      const m = text.match(/#([A-Z0-9]{2,12})\/USDT[\s\S]{0,40}?#(LONG|SHORT)\b/i);
      if (!m) return null;
      return { coin: normalizeCoin(m[1]), side: normalizeSide(m[2]) };
    },
  },
  {
    // «Buying #BICO here on Binance» — самый крупный из каналов, который вообще
    // публикует направление бесплатно (321K подписчиков), но пишет прозой,
    // поэтому берём только повелительную форму в начале строки.
    name: 'CryptoVIPsignal',
    match(text) {
      const m = text.match(/(?:^|\n)\s*(Buying|Selling|Shorting|Longing|Buy|Sell|Short)\s+(?:some\s+)?#?([A-Z0-9]{2,12})\b/);
      if (!m) return null;
      return { coin: normalizeCoin(m[2]), side: normalizeSide(m[1]) };
    },
  },
];

/** Имена поддерживаемых каналов. */
export function knownChannels() {
  return CHANNELS.map((c) => c.name);
}

/**
 * Разбор одного поста.
 * @param {string} channel
 * @param {string} text
 * @returns {{coin:string, side:'long'|'short'}|null}
 */
export function parsePost(channel, text) {
  const spec = CHANNELS.find((c) => c.name.toLowerCase() === String(channel).toLowerCase());
  if (!spec || !text) return null;
  const clean = decodeEntities(text);
  if (RESULT_MARKERS.some((re) => re.test(clean))) return null;
  const hit = spec.match(clean);
  if (!hit || !hit.coin || !hit.side) return null;
  return { coin: hit.coin, side: hit.side };
}

/**
 * Разбор пачки постов канала → сигналы, в порядке публикации.
 * @param {string} channel
 * @param {Array<{id:number, ts:string, text:string}>} posts
 * @returns {Array<{channel:string, postId:number, postedAt:number, coin:string, side:string, excerpt:string}>}
 */
export function parsePosts(channel, posts) {
  const out = [];
  for (const p of posts || []) {
    const hit = parsePost(channel, p?.text || '');
    if (!hit) continue;
    const postedAt = p.ts ? Date.parse(p.ts) : NaN;
    if (!Number.isFinite(postedAt)) continue;
    out.push({
      channel,
      postId: Number(p.id),
      postedAt,
      coin: hit.coin,
      side: hit.side,
      excerpt: decodeEntities(p.text).replace(/\s+/g, ' ').slice(0, 200),
    });
  }
  return out.sort((a, b) => a.postId - b.postId);
}
