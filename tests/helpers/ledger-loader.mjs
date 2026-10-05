const fakes = new Map([
  ['../core/config.js', 'ledger-config-fake.js'], ['../core/logger.js', 'ledger-logger-fake.js'],
  ['./userFills.js', 'ledger-fills-fake.js'], ['./funding.js', 'ledger-funding-fake.js'],
  ['./dailyRisk.js', 'ledger-day-fake.js'], ['../core/database.js', 'ledger-database-fake.js'],
]);
const helpers = new URL('.', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/modules/ledger.js') && fakes.has(specifier)) return { url: new URL(fakes.get(specifier), helpers).href, shortCircuit: true };
  return nextResolve(specifier, context);
}
