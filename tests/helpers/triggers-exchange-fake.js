export const calls = [];
let response = { response: { data: { statuses: [{ resting: { oid: 1 } }] } } };
export async function placeTrigger(args) { calls.push(args); return response; }
export function setTriggerResponse(value) { response = value; }
export function resetTriggerFake() { calls.length = 0; response = { response: { data: { statuses: [{ resting: { oid: 1 } }] } } }; }
