let asset = { szDecimals: 3 };
let parsed = { ok: true, oid: 9, totalSz: 2, avgPx: 101 };
export function resolveAsset() { return asset; }
export function parseFillResponse() { return parsed; }
export function resetFillParser({ nextAsset, nextParsed } = {}) {
  asset = nextAsset ?? { szDecimals: 3 };
  parsed = nextParsed ?? { ok: true, oid: 9, totalSz: 2, avgPx: 101 };
}
