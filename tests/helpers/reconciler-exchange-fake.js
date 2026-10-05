export let positions = [];
export let fullState = { assetPositions: [], marginSummary: { accountValue: '0' } };
export let positionsError = null;
export let fullStateError = null;
export const calls = [];

export function resetExchange({ nextPositions = [], nextFullState = { assetPositions: [], marginSummary: { accountValue: '0' } } } = {}) {
  positions = nextPositions; fullState = nextFullState; positionsError = null; fullStateError = null; calls.length = 0;
}
export function failPositions(error) { positionsError = error; }
export function failFullState(error) { fullStateError = error; }
export async function getPositions() {
  calls.push('positions');
  if (positionsError) throw positionsError;
  return typeof positions === 'function' ? positions() : positions;
}
export async function getClearinghouseStateFull() {
  calls.push('full');
  if (fullStateError) throw fullStateError;
  return typeof fullState === 'function' ? fullState() : fullState;
}
