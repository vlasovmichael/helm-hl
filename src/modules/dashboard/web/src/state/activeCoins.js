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
          // adopt-нянька отдаёт живой пол (стоп/BE/трейл) — тот же форвард, что
          // у бот-сделки. Для неусыновлённых ручных позиций bot=null (2026-06-14).
          bot: p.bot ?? null,
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
// Возвращает ВНУТРЕННОСТЬ под-строки (один <td colspan>), без обёртки <tr> —
// обёртку и data-key ставит keyed-реконсилер Hot Movers (для FLIP-анимаций).
// Пустая строка → под-строки нет.
export function hmPosHintInner(coin) {
  const p = activePosByCoin.get(coin);
  if (!p) return "";
  const { now, liq, source, bot, adopted, side, entry, sizeUsd, heldHours } = p;

  // Held-time коротким форматом: 45m / 2h13m.
  const fmtHeld = (hrs) => {
    if (hrs == null || !(hrs >= 0)) return null;
    const mins = Math.round(hrs * 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}h${m}m` : `${m}m`;
  };

  const fmtPx = (px) =>
    px == null ? "—" : px >= 100 ? px.toFixed(2) : px >= 1 ? px.toFixed(4) : px.toPrecision(4);

  // % от входа и P&L НЕ дублируем — они уже в панели Active Position. Здесь
  // только то, чего там нет: что бот УЖЕ сделал со стопом + близость ликв.
  // «Жив ли движ» читается по momentum-ячейкам самой строки (2026-06-13).
  const chips = [];
  // Что бот защищает ПРЯМО СЕЙЧАС (форвард), а не что он уже сделал. Живой пол
  // (floorPct/floorPrice/floorKind) приходит с бэка: трейл → пик−giveback,
  // BE → безубыток, иначе → жёсткий −SL. Плюс расстояние цены до триггера —
  // чтобы видеть, насколько близок выход, не дублируя P&L из Active Position.
  if (bot) {
    const fp = bot.floorPrice ?? bot.stopPrice;
    const kind = bot.floorKind;
    if (bot.floorPct != null) {
      if (kind === "trail")
        chips.push(["good", `floor +${bot.floorPct.toFixed(2)}% (trail)`]);
      else if (kind === "be") chips.push(["good", "floor breakeven (BE)"]);
      else
        chips.push([
          "neutral",
          `stop ${bot.floorPct >= 0 ? "+" : ""}${bot.floorPct.toFixed(1)}%`,
        ]);
    } else if (bot.stopPrice != null) {
      const sp = bot.stopPct != null ? ` (−${bot.stopPct.toFixed(1)}%)` : "";
      chips.push(["neutral", `stop @${fmtPx(bot.stopPrice)}${sp}`]);
    }
    // Locked profit: когда взведён BE/трейл — сколько $ бот уже зафиксировал
    // храповиком (floorPct% от номинала). Видно, что защита реально работает.
    if (
      (kind === "be" || kind === "trail") &&
      bot.floorPct > 0 &&
      sizeUsd != null
    ) {
      const lockedUsd = (bot.floorPct / 100) * sizeUsd;
      if (lockedUsd >= 0.01)
        chips.push(["good", `locked +$${lockedUsd.toFixed(2)}`]);
    }
    // R-multiple: текущий ход в единицах исходного риска (+1.2R / −0.5R).
    // Главная метрика дисциплины payoff (плюсы тянутся, минусы маленькие).
    if (bot.initialRiskPct > 0 && entry != null && now != null && now > 0) {
      const unrealPct =
        side === "SHORT"
          ? ((entry - now) / entry) * 100
          : ((now - entry) / entry) * 100;
      const r = unrealPct / bot.initialRiskPct;
      chips.push([r >= 0 ? "good" : "bad", `${r >= 0 ? "+" : ""}${r.toFixed(2)}R`]);
    }
    // Расстояние цены до спускового крючка бота — «сколько ещё до выхода».
    if (fp != null && now != null && now > 0) {
      const dist = (Math.abs(now - fp) / now) * 100;
      chips.push(["neutral", `to exit ${dist.toFixed(2)}%`]);
    }
    if (bot.peakPct != null && bot.peakPct > 0.1)
      chips.push(["neutral", `peak +${bot.peakPct.toFixed(2)}%`]);
    // Обратный отсчёт до time-stop (авто-закрытие по рынку, если ни SL, ни TP).
    // Есть только у бот-стратегий с max-hold (Hunter). Остаток = timeStop − held.
    if (bot.timeStopMin != null && heldHours != null && heldHours >= 0) {
      const remainMin = bot.timeStopMin - heldHours * 60;
      if (remainMin > 0) {
        const rm = Math.ceil(remainMin);
        const label = rm >= 60 ? `${Math.floor(rm / 60)}h${rm % 60}m` : `${rm}m`;
        chips.push(["neutral", `auto-close ~${label}`]);
      } else {
        chips.push(["neutral", "auto-close imminent"]);
      }
    }
    // Held-time — сколько держится позиция (есть только у бот-сделки).
    const held = fmtHeld(heldHours);
    if (held) chips.push(["neutral", `held ${held}`]);
  }
  // Близость ликвидации — единственный «алерт», и тот информативный.
  if (liq && now) {
    const liqDist = (Math.abs(now - liq) / now) * 100;
    if (liqDist < 8) chips.push(["danger", `⚠️ liq. in ${liqDist.toFixed(1)}%`]);
  }
  // Нет действий бота и ликв не близко → под-строка не нужна: метка активной
  // монеты остаётся на самой строке (📍 + бейдж), P&L смотри в Active Position.
  if (!chips.length) return "";

  const tag = source === "manual" ? (adopted ? "YOU + BOT" : "YOU") : "BOT";
  const chipsHtml = chips
    .map(([k, t]) => `<span class="hm-hint hm-hint-${k}">${escapeHtml(t)}</span>`)
    .join(" ");
  return `<td colspan="11">
    <span class="hm-pos-tag hm-pos-${source}">${tag}</span>${chipsHtml}
  </td>`;
}
