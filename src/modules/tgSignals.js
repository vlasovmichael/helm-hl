// ─────────────────────────────────────────────────
//  Разбор постов сигнальных TG-каналов → {монета, сторона, время}
// ─────────────────────────────────────────────────
// Вход/цели/стоп канала игнорируются: мерим прогноз, а не рисованную геометрию.
//
// 🚨 Пост-отчёт цитирует исходный сигнал целиком — без RESULT_MARKERS один
// прогноз открывал бы позу дважды, второй раз уже зная исход.
//
// В коде живут только ФОРМАТЫ постов, не имена каналов: шаблон у сигнальных
// каналов клонированный, один формат покрывает многих. Сами каналы — данные,
// они лежат в TG_SIGNAL_CHANNELS.
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

// ── Форматы постов ──────────────────────────────────────────────────────────
// Разбор строгий намеренно: пропущенный сигнал стоит одной сделки, выдуманный
// отравляет весь замер. Порядок важен — сначала форматы с именованными полями,
// свободная повелительная форма последней.
const FORMATS = [
  {
    // COIN: $XRP/USDT ⏎ Direction: LONG — карточка с именованными полями.
    id: 'labelled-card',
    match(text) {
      const coin = text.match(/COIN\s*:\s*\$?([A-Z0-9]{2,12})(?:\/USDT)?/i);
      const side = text.match(/Direction\s*:\s*\W{0,4}(LONG|SHORT)\b/i);
      if (!coin || !side) return null;
      return { coin: normalizeCoin(coin[1]), side: normalizeSide(side[1]) };
    },
  },
  {
    // #KITE/USDT ⏎ #LONG ⏎ ENTRY: … — блок с тикером и стороной через решётку.
    id: 'hashtag-block',
    match(text) {
      const m = text.match(/#([A-Z0-9]{2,12})\/USDT[\s\S]{0,40}?#(LONG|SHORT)\b/i);
      if (!m) return null;
      return { coin: normalizeCoin(m[1]), side: normalizeSide(m[2]) };
    },
  },
  {
    // ➡️ SHORT ETHUSDT ⏎ Entry: … — сторона первой, тикер следом.
    // USDT в тикере обязателен: без него сюда падала бы проза («short term»).
    id: 'side-first',
    match(text) {
      const m = text.match(/(?:^|\n)[^\w\n]{0,8}(LONG|SHORT)\s+#?([A-Z0-9]{2,12})\/?USDT\b/i);
      if (!m) return null;
      return { coin: normalizeCoin(m[2]), side: normalizeSide(m[1]) };
    },
  },
  {
    // «Buying #BICO here on Binance» — только повелительная форма с начала
    // строки: «мы откроем лонг после подтверждения» это намерение, не сигнал.
    id: 'imperative',
    match(text) {
      const m = text.match(/(?:^|\n)\s*(Buying|Selling|Shorting|Longing|Buy|Sell|Short)\s+(?:some\s+)?#?([A-Z0-9]{2,12})\b/);
      if (!m) return null;
      return { coin: normalizeCoin(m[2]), side: normalizeSide(m[1]) };
    },
  },
];

/** Опознаваемые форматы постов. */
export function knownFormats() {
  return FORMATS.map((f) => f.id);
}

/**
 * Разбор поста любым из известных форматов. Первый подошедший и выигрывает.
 * @param {string} text
 * @returns {{coin:string, side:'long'|'short', format:string}|null}
 */
export function parsePost(text) {
  if (!text) return null;
  const clean = decodeEntities(text);
  if (RESULT_MARKERS.some((re) => re.test(clean))) return null;
  for (const f of FORMATS) {
    const hit = f.match(clean);
    if (hit?.coin && hit.side) return { coin: hit.coin, side: hit.side, format: f.id };
  }
  return null;
}

/**
 * Разбор пачки постов канала → сигналы, в порядке публикации.
 * @param {string} channel — хэндл, только чтобы протащить его в сигнал
 * @param {Array<{id:number, ts:string, text:string}>} posts
 * @returns {Array<{channel:string, postId:number, postedAt:number, coin:string,
 *                  side:string, format:string, excerpt:string}>}
 */
export function parsePosts(channel, posts) {
  const out = [];
  for (const p of posts || []) {
    const hit = parsePost(p?.text || '');
    if (!hit) continue;
    const postedAt = p.ts ? Date.parse(p.ts) : NaN;
    if (!Number.isFinite(postedAt)) continue;
    out.push({
      channel,
      postId: Number(p.id),
      postedAt,
      coin: hit.coin,
      side: hit.side,
      format: hit.format,
      excerpt: decodeEntities(p.text).replace(/\s+/g, ' ').slice(0, 200),
    });
  }
  return out.sort((a, b) => a.postId - b.postId);
}
