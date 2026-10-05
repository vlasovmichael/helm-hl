export const calls = [];
let positions = [{ position: { coin: 'ETH', szi: '-2' } }];
let book = { levels: [[{ px: '100' }], [{ px: '101' }]] };
let limitResult = { response: { data: { statuses: [{ filled: { oid: 7, totalSz: '2', avgPx: '100' } }] } } };
let marketResult = {};
let cancelError = null;
export async function getPositions() {
  if (typeof positions === 'function') return positions();
  if (positions instanceof Error) throw positions;
  return positions;
}
export async function getOrderBook() { if (book instanceof Error) throw book; return book; }
export async function placeLimit(args) { calls.push(['limit', args]); return limitResult; }
export async function closeMarket(...args) { calls.push(['market', args]); return marketResult; }
export async function cancelOrderFor(...args) { calls.push(['cancel', args]); if (cancelError) throw cancelError; }
export function resetExchange({ nextPositions, nextBook, nextLimitResult, nextMarketResult, nextCancelError } = {}) {
  calls.length = 0;
  positions = nextPositions ?? [{ position: { coin: 'ETH', szi: '-2' } }];
  book = nextBook ?? { levels: [[{ px: '100' }], [{ px: '101' }]] };
  limitResult = nextLimitResult ?? { response: { data: { statuses: [{ filled: { oid: 7, totalSz: '2', avgPx: '100' } }] } } };
  marketResult = nextMarketResult ?? {};
  cancelError = nextCancelError ?? null;
}
