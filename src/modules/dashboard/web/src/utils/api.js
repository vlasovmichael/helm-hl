// ─────────────────────────────────────────────────
//  Разбор ответа API — одно место на весь дашборд
// ─────────────────────────────────────────────────
// Раньше по коду стояло голое `r.json()` после проверки на 401. Присваивание
// `location.href` НЕ прерывает выполнение, поэтому парсер всё равно получал
// HTML страницы логина и падал с «Unexpected token '<', "<!DOCTYPE "... is not
// valid JSON». Именно это висело в красной плашке Trade Ticket вместо причины.
//
// HTML вместо JSON приходит не только от логина: истёкшая сессия Cloudflare
// Access отдаёт свою страницу, необработанное исключение в Express — свою.
// Во всех случаях правда одна: ответ не наш, и парсить его нечего, а человеку
// нужно не имя токена, а что делать дальше.

/**
 * Прочитать ответ как JSON.
 *
 * @param {Response} r
 * @param {() => void} [onUnauthorized] — куда уводить при 401 (в браузере это
 *   редирект на /login; в тестах — заглушка).
 * @returns {Promise<any>}
 * @throws {Error} с текстом, пригодным для показа человеку
 */
export async function readJson(r, onUnauthorized) {
  if (r.status === 401) {
    onUnauthorized?.();
    throw new Error("session expired — reloading the login page");
  }
  const text = await r.text();
  try {
    return JSON.parse(text);
  } catch {
    // Пустое тело — отдельный случай: 204 и подобные это не ошибка разбора.
    if (!text.trim()) throw new Error(`empty answer from the server (HTTP ${r.status})`);
    const looksLikeHtml = /^\s*</.test(text);
    throw new Error(
      looksLikeHtml
        ? `the server answered with a page instead of data (HTTP ${r.status}) — ` +
          `the session has probably expired, reload the tab`
        : `unreadable answer from the server (HTTP ${r.status})`,
    );
  }
}
