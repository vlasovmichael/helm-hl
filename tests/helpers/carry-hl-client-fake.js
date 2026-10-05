export const HL_PRIORITY = { LOW: 'low' };
export async function hlInfo(request, options) {
  return globalThis.__carryHlInfo(request, options);
}
