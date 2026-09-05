// ─────────────────────────────────────────────────────────────────────────────
//  venueCollector — фандинг и спред площадок HIP-3 против основного DEX'а
//
//  🚨 Единственная гипотеза в наборе, которую нельзя мерить на прошлом ПО
//  ФИЗИЧЕСКОЙ причине: площадки xyz/flx/vntl и прочие открылись недавно, и
//  истории у них практически нет. Копить можно только вперёд.
//
//  Вопрос: систематически ли фандинг и спред на молодых площадках отличаются от
//  основного DEX'а. Молодой рынок часто оценивает фандинг криво — если разница
//  устойчива, это carry без предсказания направления.
//
//  Лёгкий: metaAndAssetCtxs весит 20, берём по одной площадке за круг.
//  Запуск раз в час кроном:
//    docker exec hl-paper-scanner node tools/venueCollector.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { initDB, recordVenueSnapshot } from '../src/core/database.js';
import { hlInfo, HL_PRIORITY } from '../src/core/hlClient.js';
import { KNOWN_BUILDER_DEXES } from '../src/modules/winnersPositions.js';

initDB();

const DEXES = ['', ...KNOWN_BUILDER_DEXES];
const ts = Math.floor(Date.now() / 3_600_000) * 3_600_000; // час — ключ снимка

let saved = 0;
for (const dex of DEXES) {
  let res;
  try {
    res = await hlInfo(
      dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' },
      { label: 'venueCollector', timeoutMs: 15_000, maxRetries: 2, priority: HL_PRIORITY.LOW },
    );
  } catch (err) {
    console.error(`${dex || 'main'}: ${err.message}`);
    continue;
  }
  const universe = res?.[0]?.universe ?? [];
  const ctxs = res?.[1] ?? [];
  for (let i = 0; i < universe.length; i++) {
    const name = universe[i]?.name;
    const c = ctxs[i];
    if (!name || !c) continue;
    const mid = Number(c.midPx ?? c.markPx);
    const impact = Array.isArray(c.impactPxs) ? c.impactPxs.map(Number) : null;
    // Спред считаем по impactPxs: это цены исполнения заметного объёма, то есть
    // то, что реально заплатит тейкер, а не косметическая разница лучших котировок.
    const spreadBp =
      impact && impact.length === 2 && impact[0] > 0 && impact[1] > 0 && mid > 0
        ? ((impact[1] - impact[0]) / mid) * 10000
        : null;
    if (
      recordVenueSnapshot({
        ts,
        dex: dex || 'main',
        coin: name,
        mid: Number.isFinite(mid) ? mid : null,
        spread_bp: Number.isFinite(spreadBp) ? spreadBp : null,
        funding: Number.isFinite(Number(c.funding)) ? Number(c.funding) : null,
        oi_usd: Number.isFinite(Number(c.openInterest)) && Number.isFinite(mid)
          ? Number(c.openInterest) * mid
          : null,
      })
    ) {
      saved++;
    }
  }
}
console.log(`снимок ${new Date(ts).toISOString().slice(0, 16)}: записано строк ${saved}`);
