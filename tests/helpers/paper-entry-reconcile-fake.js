export let stop = { distPct: 2, basis: 'fixed' };
export let failure = null;
export function setStop(v) { stop = v; failure = null; }
export function fail(err = new Error('no stop')) { failure = err; }
export async function computeStopDistPct() { if (failure) throw failure; return stop; }
export function computeAdoptTp({ side, entry, stopDistPct, rr, maxPct }) {
  const distPct = Math.min(stopDistPct * rr, maxPct);
  return { distPct, tpPrice: side === 'short' ? entry * (1 - distPct / 100) : entry * (1 + distPct / 100) };
}
