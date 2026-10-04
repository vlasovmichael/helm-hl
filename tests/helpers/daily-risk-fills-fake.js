let fills = [];
let failure = null;
export async function fetchUserFills() { if (failure) throw failure; return fills; }
export function setFills(value) { fills = value; }
export function setFailure(value) { failure = value; }
export function resetFills() { fills = []; failure = null; }
