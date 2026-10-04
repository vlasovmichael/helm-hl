export const calls = [];
export async function retryWithBackoff(action, options) { calls.push(options); return action(); }
export function resetRetry() { calls.length = 0; }
