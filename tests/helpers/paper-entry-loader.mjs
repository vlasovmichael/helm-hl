const fakes = new Map([
  ['../core/config.js', 'paper-entry-config-fake.js'],
  ['./paperNannyGate.js', 'paper-entry-gate-fake.js'],
  ['../core/logger.js', 'paper-entry-logger-fake.js'],
  ['../core/database.js', 'paper-entry-database-fake.js'],
  ['../core/priceFeed.js', 'paper-entry-price-fake.js'],
  ['./exchange.js', 'paper-entry-exchange-fake.js'],
  ['./wallet.js', 'paper-entry-wallet-fake.js'],
  ['../app/adoptReconcile.js', 'paper-entry-reconcile-fake.js'],
]);
const helpers = new URL('.', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/modules/paperEntry.js') && fakes.has(specifier)) {
    return { url: new URL(fakes.get(specifier), helpers).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
