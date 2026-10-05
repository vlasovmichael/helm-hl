export let equity = 0;
export let failure = null;
export function setEquity(v) { equity = v; failure = null; }
export function fail(err = new Error('wallet offline')) { failure = err; }
export async function getAccountEquity() { if (failure) throw failure; return equity; }
