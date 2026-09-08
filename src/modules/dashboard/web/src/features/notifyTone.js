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

// Явная сторона сделки — только из ЗАГОЛОВКА («LONG #DOT opened»). 🚨 Не из
// тела: дайджест чужих сделок перечисляет в нём и лонги, и шорты, и событие
// получало сторону первой попавшейся строки.
export function toastSide(item) {
  const t = String(item.title || "");
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

// Тип информационного события → иконка. Порядок от частного к общему.
function infoGlyph(item, dir) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const title = String(item.title || "");
  if (/событ|digest|сводка/i.test(title)) return "history";  // дайджест за период
  if (/\bOI\b/i.test(title)) return "flow";                  // радар открытого интереса
  if (/\badopted\b|усынов/i.test(title)) return "bot";       // нянька подхватила
  if (/funding|фандинг/i.test(title)) return "clock";
  if (tags.includes("eyes") || /started moving|проснул/i.test(title)) return "eye";
  return dir === "up" ? NOTIF_ICON.up : dir === "down" ? NOTIF_ICON.down : NOTIF_ICON.info;
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
  // Цвет — по исходу, иконка — по стороне: у убыточного лонга стрелка вверх
  // и рамка красная, и обе вещи читаются сразу.
  if (/\bclosed\b|закрыт/i.test(title)) {
    const m = msg.match(/pnl\s*([+\-−])/i);
    const win = m ? m[1] === "+" : !/[-−]\$/.test(msg);
    const glyph = side || (win ? "check" : "falling");
    return win
      ? { kind: "ok", cls: "toast--ok", glyph, side }
      : { kind: "loss", cls: "toast--danger", glyph, side };
  }

  // Режимные предупреждения — про СОСТОЯНИЕ БОТА (пауза, кулдаун, протухшие
  // данные), а не про слова в описании рынка.
  //
  // 🚨 «flush» и «squeeze» сюда не добавлять: радар OI пишет ими про рынок
  // («longs being flushed»), и информационный пуш получал жёлтый треугольник.
  // Свой warn у breadth-flush есть — тег snowflake, и иконка у него снежинка.
  if (has("snowflake")) {
    return { kind: "warn", cls: "toast--warn", glyph: "cold", side };
  }
  if (/\bwarn|stale|cooldown|paused|\bcold\b|\bskip/.test(text)) {
    return { kind: "warn", cls: "toast--warn", glyph: "warn", side };
  }

  // Сторона сделки — стрелка вверх/вниз, зелёная у лонга, красная у шорта.
  // Это НЕ обещание исхода: у входа его ещё нет, тон здесь означает сторону.
  if (side) {
    const kind = side === "long" ? "up" : "down";
    return { kind, cls: `toast--${kind}`, glyph: side, side };
  }

  // Радар и будильники: направление несёт ЦВЕТ, иконка остаётся по типу события.
  // 🚨 Не отдавать им стрелку: с одной стрелкой на всех радар OI, будильник
  // вотчлиста и дайджест читаются как одна строка, повторённая сто раз.
  const dir = toastDir(item);
  const glyph = infoGlyph(item, dir);
  return dir
    ? { kind: dir, cls: `toast--${dir}`, glyph, side }
    : { kind: "info", cls: "", glyph, side };
}

// Разбор тела дайджеста чужих сделок на колонки. Markup — в notifications.js.
// \u25b2\u25bc\u00d7\u21c4 — маркеры OPEN/CLOSE/FLIP. Escape'ами, а не символами:
// сторож глифов не отличает разбор чужого текста от вывода в интерфейс.
const DIGEST_LINE = /^([\u25b2\u25bc\u00d7\u21c4])\s+(OPEN|CLOSE|FLIP)\s+(.+)$/;
const SIGNED_MONEY = /^([+\-\u2212])\$|^\$([+\-\u2212])/;

/**
 * @param {string} message — тело пуша целиком
 * @returns {Array<{kind:'open'|'close'|'flip', head:string, pnl:string|null,
 *                  sign:'pos'|'neg'|null, meta:string}>|null} null — это не дайджест
 */
export function parseDigest(message) {
  const rows = [];
  for (const raw of String(message || "").split("\n")) {
    const m = DIGEST_LINE.exec(raw.trim());
    if (!m) continue;
    const parts = m[3].split("\u00b7").map((x) => x.trim()).filter(Boolean);
    const head = parts.shift() || "";
    const pnlAt = parts.findIndex((x) => SIGNED_MONEY.test(x));
    const pnl = pnlAt >= 0 ? parts.splice(pnlAt, 1)[0] : null;
    rows.push({
      kind: m[2].toLowerCase(),
      head,
      pnl,
      sign: pnl ? (/^[-\u2212]|\$[-\u2212]/.test(pnl) ? "neg" : "pos") : null,
      meta: parts.join(" \u00b7 "),
    });
  }
  return rows.length ? rows : null;
}
