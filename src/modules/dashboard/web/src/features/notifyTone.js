// Уведомления: во что окрасить пуш. Чистая логика без DOM — проверяется
// в tests/notifyTone.test.js.

// Иконка события — ключ из общего набора (core/icon.js). Раньше здесь лежали
// шесть контуров, набранных руками под viewBox 24: у них был свой stroke-width,
// и рядом с иконками остального дашборда они читались как из другого набора.
const NOTIF_ICON = {
  ok: "check",
  danger: "danger",
  warn: "warn",
  up: "rising",
  down: "falling",
  info: "info",
};

// Явная сторона сделки — только когда в тексте есть слово LONG/SHORT (fade-алерты,
// филлы). Тогда показываем цветную пилюлю. Для радара OI/move это не «сторона».
export function toastSide(item) {
  const t = `${item.title || ""} ${item.message || ""}`;
  if (/\bshort\b/i.test(t)) return "short";
  if (/\blong\b/i.test(t)) return "long";
  return null;
}

// Направление движения — из ntfy-тегов и из стрелки в заголовке (радар OI
// шлёт «OI #PONS ▼ −3.8%»). Даёт иконку-тренд.
export function toastDir(item) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const has = (x) => tags.includes(x);
  const title = String(item.title || "");
  // \u25B2 / \u25BC — те самые ▲▼ из заголовка ntfy. Escape'ами, а не
  // символами: проверка глифов (scripts/checkGlyphs.mjs) не отличает разбор
  // чужого текста от вывода в интерфейс, и правильно делает.
  if (has("green_circle") || has("chart_with_upwards_trend") || title.includes("\u25B2")) return "up";
  if (has("red_circle") || has("chart_with_downwards_trend") || title.includes("\u25BC")) return "down";
  return null;
}

// Одна функция на тост и на список: одно событие выглядит одинаково в обоих.
// Цвет означает ИСХОД (плюс/минус/авария), а не тип события.
//
// 🚨 Порядок правил: исход сделки идёт ПЕРВЫМ. Слово «stop» есть в причине
// выхода почти любого закрытия, включая прибыльные, а убыточное приезжает с
// priority 4 — правило про danger выше по коду красит красным вообще всё.
export function classifyNotif(item) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const has = (t) => tags.includes(t);
  const title = String(item.title || "");
  const msg = String(item.message || "");
  const text = `${title} ${msg}`.toLowerCase();
  const side = toastSide(item);

  // Авария: не про исход сделки, а про то, что что-то сломалось или встало.
  const isAlert =
    has("rotating_light") && !/\bclosed\b/i.test(title)
      ? true
      : /liquidat|circuit breaker|drawdown|reconcile|внешнее закрытие|закрыта оффлайн|ошибка|error|failed/.test(
          text,
        );
  if (isAlert) return { kind: "danger", cls: "toast--danger", glyph: "danger", side };

  // Закрытие: знак PnL в теле. «PnL +$3.10 · held 2h · trail» → плюс.
  if (/\bclosed\b|закрыт/i.test(title)) {
    const m = msg.match(/pnl\s*([+\-−])/i);
    const win = m ? m[1] === "+" : !/[-−]\$/.test(msg);
    return win
      ? { kind: "ok", cls: "toast--ok", glyph: "check", side }
      : { kind: "loss", cls: "toast--danger", glyph: "falling", side };
  }

  // Режимные предупреждения — про СОСТОЯНИЕ БОТА (пауза, кулдаун, протухшие
  // данные), а не про слова в описании рынка.
  //
  // 🚨 «flush» и «squeeze» сюда не добавлять: радар OI пишет ими про рынок
  // («longs being flushed»), и информационный пуш получал жёлтый треугольник.
  // Свой warn у breadth-flush есть — он приходит с тегом snowflake.
  if (has("snowflake") || /\bwarn|stale|cooldown|paused|\bcold\b|\bskip/.test(text)) {
    return { kind: "warn", cls: "toast--warn", glyph: "warn", side };
  }

  // Вход и всё остальное — нейтрально: у открытия исхода ещё нет, и красить
  // его в «успех» значит обещать то, чего никто не знает.
  const dir = toastDir(item) || (side === "long" ? "up" : side === "short" ? "down" : null);
  const glyph = dir === "up" ? NOTIF_ICON.up : dir === "down" ? NOTIF_ICON.down : NOTIF_ICON.info;
  return { kind: "info", cls: "", glyph, side };
}
