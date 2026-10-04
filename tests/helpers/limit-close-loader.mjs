const fakes = new Map([
  ['../../core/logger.js', 'limit-close-logger-fake.js'],
  ['../../core/retry.js', 'limit-close-retry-fake.js'],
  ['../../core/config.js', 'limit-close-config-fake.js'],
  ['../exchange.js', 'limit-close-exchange-fake.js'],
  ['./fill-parser.js', 'limit-close-fill-parser-fake.js'],
  ['./math.js', 'limit-close-math-fake.js'],
  ['../userFills.js', 'limit-close-fills-fake.js'],
]);
const helpers = new URL('.', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/modules/executor/limitClose.js') && fakes.has(specifier)) {
    return { url: new URL(fakes.get(specifier), helpers).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
