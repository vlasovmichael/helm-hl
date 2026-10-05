export let value = new Map();
export let failure = null;
export function setMap(v) { value = v; failure = null; }
export function fail(err = new Error('offline')) { failure = err; }
export async function getLivePriceMap() { if (failure) throw failure; return value; }
