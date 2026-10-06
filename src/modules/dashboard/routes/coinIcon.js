// ─────────────────────────────────────────────────
//  Иконки монет — SVG с Hyperliquid через наш сервер
// ─────────────────────────────────────────────────
// Страницы не ходят на чужой домен: иконка скачивается один раз и живёт в
// памяти процесса. Нет иконки — отдаётся кружок с буквой, чтобы ряд не прыгал.

const SOURCE = "https://app.hyperliquid.xyz/coins";
const FETCH_TIMEOUT_MS = 5_000;
const MISS_RETRY_MS = 6 * 60 * 60_000;
const BROWSER_CACHE = "public, max-age=604800";
const MISS_CACHE = "public, max-age=3600";
const VALID = /^[A-Za-z0-9:_-]{1,32}$/;
const MAX_ENTRIES = 1000; // вселенная HL — пара сотен монет, больше — мусорные имена

// имя → { svg, at, miss }
const icons = new Map();

/** Имя файла у HL: k-монеты (kPEPE = 1000 PEPE) лежат под базовым тикером. */
export function iconName(coin) {
  return /^k[A-Z0-9]/.test(coin) ? coin.slice(1) : coin;
}

/** Кружок с первой буквой: монета без иконки не ломает ряд. */
export function letterSvg(coin) {
  const ch = (iconName(coin).match(/[A-Za-z0-9]/)?.[0] || "?").toUpperCase();
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<circle cx="16" cy="16" r="16" fill="#8b949e"/>` +
    `<text x="16" y="21.5" text-anchor="middle" font-family="sans-serif" font-size="16" font-weight="600" fill="#fff">${ch}</text>` +
    `</svg>`
  );
}

async function download(name) {
  try {
    const res = await fetch(`${SOURCE}/${encodeURIComponent(name)}.svg`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // На неизвестное имя HL отвечает 200 со страницей приложения, а не 404.
    if (!res.ok || !String(res.headers.get("content-type")).includes("svg")) return null;
    const svg = await res.text();
    return svg.includes("<svg") ? svg : null;
  } catch {
    return null;
  }
}

/** @returns {Promise<{svg: string, miss: boolean}>} miss — отдана буква вместо иконки */
export async function iconSvg(coin, now = Date.now()) {
  const name = iconName(coin);
  const hit = icons.get(name);
  if (hit && (!hit.miss || now - hit.at < MISS_RETRY_MS)) return hit;
  const svg = await download(name);
  const entry = svg ? { svg, at: now, miss: false } : { svg: letterSvg(coin), at: now, miss: true };
  if (icons.size >= MAX_ENTRIES) icons.clear();
  icons.set(name, entry);
  return entry;
}

export async function handleCoinIcon(req, res) {
  const coin = String(req.params.coin || "");
  if (!VALID.test(coin)) return res.status(400).end();
  const { svg, miss } = await iconSvg(coin);
  res.set("Content-Type", "image/svg+xml");
  res.set("Cache-Control", miss ? MISS_CACHE : BROWSER_CACHE);
  // Чужой SVG с нашего домена: открытый напрямую, он не должен исполнять скрипты.
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'");
  res.set("X-Content-Type-Options", "nosniff");
  res.send(svg);
}
