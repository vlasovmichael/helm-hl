export const calls = [];

let state;
export function resetCloseDeps(overrides = {}) {
  state = {
    positions: [{ position: { coin: 'ETH', cumFunding: { sinceOpen: '-0.5' } } }],
    summary: { equity: 110 },
    marketResult: { response: 'market' },
    parsedFill: { ok: true, oid: 7, totalSz: 2, avgPx: 110 },
    limitFill: { ok: true, oid: 8, totalSz: 2, avgPx: 110, kind: 'limit' },
    closeLimitEnabled: false,
    userFills: [],
    classified: { reason: 'external_unknown', fee: 0, pnl: null, closePx: null, closedAt: null },
    roundTrip: null,
    slippage: { ban: false, warn: false, label: '0.00%' },
    pnl: { pricePnl: 2, fundingPnl: 0.5, totalFee: 0.1, realizedPnl: 2.4, fundingSource: 'real' },
    lossTrips: false,
    ...overrides,
  };
  calls.length = 0;
}
resetCloseDeps();

const note = (name, ...args) => calls.push([name, ...args]);
export const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (...args) => note(`log:${level}`, ...args)]));
export async function retryWithBackoff(fn, options) { note('retry', options); return fn(); }
export function closePosition(...args) { note('dbClose', ...args); }
export function recordBotOid(...args) { note('oid', ...args); }
export async function closeMarket(...args) { note('market', ...args); if (state.marketError) throw state.marketError; return state.marketResult; }
export async function getAccountSummary() { note('summary'); if (state.summaryError) throw state.summaryError; return state.summary; }
export async function getPositions() { note('positions'); if (state.positionsError) throw state.positionsError; return typeof state.positions === 'function' ? state.positions() : state.positions; }
export function parseFillResponse(...args) { note('parse', ...args); return state.parsedFill; }
export async function closeLimitFirst(...args) { note('limit', ...args); if (state.limitError) throw state.limitError; return state.limitFill; }
export async function fetchUserFills(...args) { note('fills', ...args); if (state.fillsError) throw state.fillsError; return state.userFills; }
export function classifyClose(...args) { note('classify', ...args); return state.classified; }
export function findRoundTripForPosition(...args) { note('roundTrip', ...args); return state.roundTrip; }
export const FEE_RATE = 0.0002;
export const MAKER_FEE_RATE = 0.00003;
export const MARKET_SLIPPAGE = 0.03;
export function checkSlippage(...args) { note('slippage', ...args); return state.slippage; }
export function calcPnl(...args) { note('pnl', ...args); return state.pnl; }
export const config = { trading: { get closeLimitEnabled() { return state.closeLimitEnabled; } } };
export const SLIPPAGE_BAN_TTL_MS = 600_000;
export const REENTRY_COOLDOWN_MS = 900_000;
export const CB_PAUSE_MS = 1_800_000;
export function banSlippage(...args) { note('ban', ...args); }
export function setCooldown(...args) { note('cooldown', ...args); }
export function recordLoss(...args) { note('loss', ...args); return state.lossTrips; }
export function reconcile(...args) { note('reconcile', ...args); }
export function notify(...args) { note('hook', ...args); }
export function clearAdoptState(...args) { note('clearAdopt', ...args); }
export function getAdoptPeakPct() { return 9; }
export function consumeAdoptMfeMae(...args) { note('mfeMae', ...args); return { mfePct: 4, maePct: -2 }; }
export function finalizeAdoptTimeCut(...args) { note('timeCut', ...args); }
export function finalizeAdoptShadowTrail(...args) { note('trail', ...args); }
export function clearAdoptShadowTrail(...args) { note('clearTrail', ...args); }
export async function notifySlippageBan(payload) { note('notifyBan', payload); }
export async function notifyProductionClose(payload) { note('notifyClose', payload); }
export async function notifyCloseRejected(payload) { note('notifyRejected', payload); }
export async function notifyCloseFailed(payload) { note('notifyFailed', payload); }
export async function notifyExternalClose(payload) { note('notifyExternal', payload); }
export async function notifyCircuitBreaker(payload) { note('notifyBreaker', payload); }
