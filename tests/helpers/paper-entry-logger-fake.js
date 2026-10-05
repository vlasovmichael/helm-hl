export const messages = [];
export const logger = { info: (x) => messages.push(['info', x]), warn: (x) => messages.push(['warn', x]) };
export function resetLogger() { messages.length = 0; }
