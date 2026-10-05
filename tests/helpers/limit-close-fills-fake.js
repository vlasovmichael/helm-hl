let fills = [];
export const calls = [];
export async function fetchUserFills(...args) {
  calls.push(args);
  if (fills instanceof Error) throw fills;
  return typeof fills === 'function' ? fills(...args) : fills;
}
export function setFills(next) { fills = next; }
export function resetFills() { fills = []; calls.length = 0; }
