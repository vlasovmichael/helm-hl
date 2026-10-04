const fakes = new Map([
  ['../../core/retry.js', 'triggers-retry-fake.js'],
  ['../exchange.js', 'triggers-exchange-fake.js'],
]);
const helpers = new URL('.', import.meta.url).href;
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/modules/executor/triggers.js') && fakes.has(specifier)) {
    return { url: new URL(fakes.get(specifier), helpers).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
