const fakes = new Map([
  ['../core/config.js', 'daily-risk-config-fake.js'],
  ['../core/logger.js', 'daily-risk-logger-fake.js'],
  ['../core/balanceCache.js', 'daily-risk-balance-fake.js'],
  ['./userFills.js', 'daily-risk-fills-fake.js'],
]);

const helpers = new URL('.', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/modules/dailyRisk.js') && fakes.has(specifier)) {
    return { url: new URL(fakes.get(specifier), helpers).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
