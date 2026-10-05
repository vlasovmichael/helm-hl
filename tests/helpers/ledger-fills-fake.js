export let fills = []; export let trades = []; export function setTrades(value) { trades = value; }
export async function fetchUserFills() { return fills; }
export function reconstructRoundTrips() { return trades; }
