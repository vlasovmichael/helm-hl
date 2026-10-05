export const calls = [];
export const logger = {
  info(message) { calls.push(['info', message]); },
  warn(message) { calls.push(['warn', message]); },
  debug(message) { calls.push(['debug', message]); },
};
export function resetLogger() { calls.length = 0; }
