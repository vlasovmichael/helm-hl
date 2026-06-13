// ─────────────────────────────────────────────────
//  Активные монеты (позиция бота + все ручные/HANDS-OFF). Подсвечиваем их во
//  всех лентах монет (Hot Movers / Divergence / Candy Girl), чтобы оператор видел
//  свою монету выделенной, пока торгует руками (2026-06-09).
//  Общее состояние — стейт приватный, наружу только аксессоры + апдейтер.
// ─────────────────────────────────────────────────

import { escapeHtml } from "../utils/format.js";

let activeCoinSet = new Set();
// coin → краткая сводка открытой позиции (для пин-строки в Hot Movers).
let activePosByCoin = new Map();

export function updateActiveCoinSet(activePosition, manualPositions) {
  const next = new Set();
  const posMap = new Map();
  if (activePosition?.coin) {
    next.add(activePosition.coin);
    posMap.set(activePosition.coin, {
      side: (activePosition.side || "SHORT").toUpperCase(),
      entry: activePosition.entryPrice ?? null,
      now: activePosition.currentPrice ?? null,
      pnl: activePosition.currentPnl?.netMarket ?? null,
      heldHours: activePosition.heldHours ?? null,
      sizeUsd: activePosition.sizeUsd ?? null,
      liq: null,
      bot: activePosition.bot ?? null,
      source: "bot",
    });
  }
  if (Array.isArray(manualPositions))
    for (const p of manualPositions)
      if (p?.coin) {
        next.add(p.coin);
        posMap.set(p.coin, {
          side: (p.side || "").toUpperCase(),
          entry: p.entryPrice ?? null,
          now: p.currentPrice ?? null,
          pnl: p.unrealizedPnl ?? null,
          heldHours: null, // у ручной позы нет entry_time в payload
          sizeUsd: p.sizeUsd ?? null,
          liq: p.liquidationPrice ?? null,
          bot: null, // ручную позу ведёт adopt-нянька (стоп на бирже), не отдаём детали
          adopted: !!p.adopted,
          source: "manual",
        });
      }
  activeCoinSet = next;
  activePosByCoin = posMap;
}

export function isActiveCoin(coin) {
  return coin != null && activeCoinSet.has(coin);
}

// Текущий Set активных монет (read-only обход) + сводка позиции по монете.
export function getActiveCoins() {
  return activeCoinSet;
}
export function getActivePos(coin) {
  return activePosByCoin.get(coin);
}

// Под-строка Hot Movers для ОТКРЫТОЙ монеты: СТАТУС позиции, а не советы.
// Позицию ведёт бот (Hunter SHORT / adopt-нянька на ручных входах) — он сам
// двигает стоп в безубыток, трейлит и режет. Поэтому показываем что бот УЖЕ
// сделал (стоп / BE-храповик / трейл / пик), а не «двигай стоп», чтобы не
// провоцировать оператора лезть руками в сделку, от которой он ушёл (2026-06-13).
export function hmPosHintRow(coin) {
  const p = activePosByCoin.get(coin);
  if (!p) return "";
  const { now, liq, source, bot, adopted } = p;

  const fmtPx = (px) =>
    px == null ? "—" : px >= 100 ? px.toFixed(2) : px >= 1 ? px.toFixed(4) : px.toPrecision(4);

  // % от входа и P&L НЕ дублируем — они уже в панели Active Position. Здесь
  // только то, чего там нет: что бот УЖЕ сделал со стопом + близость ликв.
  // «Жив ли движ» читается по momentum-ячейкам самой строки (2026-06-13).
  const chips = [];
  // Что делает бот: стоп / BE / трейл / пик.
  if (bot) {
    if (bot.stopPrice != null) {
      const sp = bot.stopPct != null ? ` (−${bot.stopPct.toFixed(1)}%)` : "";
      chips.push(["neutral", `стоп @${fmtPx(bot.stopPrice)}${sp}`]);
    }
    if (bot.beArmed) chips.push(["good", "BE взведён"]);
    if (bot.trailArmed) chips.push(["good", "трейл активен"]);
    if (bot.peakPct != null && bot.peakPct > 0.1)
      chips.push(["neutral", `пик +${bot.peakPct.toFixed(2)}%`]);
  }
  // Близость ликвидации — единственный «алерт», и тот информативный.
  if (liq && now) {
    const liqDist = (Math.abs(now - liq) / now) * 100;
    if (liqDist < 8) chips.push(["danger", `⚠️ ликв. в ${liqDist.toFixed(1)}%`]);
  }
  // Нет действий бота и ликв не близко → под-строка не нужна: метка активной
  // монеты остаётся на самой строке (📍 + бейдж), P&L смотри в Active Position.
  if (!chips.length) return "";

  const tag = source === "manual" ? (adopted ? "ТЫ + бот" : "ТЫ") : "BOT";
  const chipsHtml = chips
    .map(([k, t]) => `<span class="hm-hint hm-hint-${k}">${escapeHtml(t)}</span>`)
    .join(" ");
  return `<tr class="hm-pos-row"><td colspan="11">
    <span class="hm-pos-tag hm-pos-${source}">${tag}</span>${chipsHtml}
  </td></tr>`;
}
