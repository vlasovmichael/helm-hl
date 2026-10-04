const here = new URL('./', import.meta.url);
const fakes = new Map([
  ['../../core/logger.js', 'reconciler-logger-fake.js'],
  ['../exchange.js', 'reconciler-exchange-fake.js'],
  ['../../core/ntfy.js', 'reconciler-ntfy-fake.js'],
  ['./math.js', 'reconciler-math-fake.js'],
]);

export async function resolve(specifier, context, nextResolve) {
  if (process.env.RECONCILER_FAKE_DEPS === '1' && context.parentURL?.endsWith('/src/modules/executor/reconciler.js') && fakes.has(specifier)) {
    return { url: new URL(fakes.get(specifier), here).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
