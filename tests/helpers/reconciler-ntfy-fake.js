export const notifications = [];
export async function fireNtfy(message) { notifications.push(message); }
export function resetNtfy() { notifications.length = 0; }
