export const saved = [];
export function savePosition(row) { saved.push(row); return saved.length; }
export function resetDatabase() { saved.length = 0; }
