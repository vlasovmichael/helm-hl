export const RUNTIME_BAN_TTL_MS = 30 * 60_000;

const bans = [];

export function banRuntime(coin) {
  bans.push(coin);
}

export function getRuntimeBans() {
  return [...bans];
}

export function resetRuntimeBans() {
  bans.length = 0;
}
