export const logs = [];
export const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((level) => [level, (message) => logs.push([level, message])]));
export function resetLogger() { logs.length = 0; }
