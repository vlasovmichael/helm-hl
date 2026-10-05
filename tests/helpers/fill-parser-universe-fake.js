let assets = [];
let fresh = false;

export function resetUniverse({ universe = [], isFresh = false } = {}) {
  assets = universe;
  fresh = isFresh;
}

export function getUniverse() {
  return assets;
}

export function findAsset(coin) {
  return assets.find((asset) => asset.name.toUpperCase() === coin.toUpperCase());
}

export function isUniverseFresh() {
  return fresh;
}
