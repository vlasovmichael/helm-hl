const entries = [];

export const logger = {
  error(message) { entries.push(['error', message]); },
  warn(message) { entries.push(['warn', message]); },
};

export function getLogEntries() {
  return [...entries];
}

export function resetLogEntries() {
  entries.length = 0;
}
