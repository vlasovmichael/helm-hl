export const calls = [];
export const logger = { warn: (message) => calls.push(['warn', message]), debug: (message) => calls.push(['debug', message]) };
export function resetLogger() { calls.length = 0; }
