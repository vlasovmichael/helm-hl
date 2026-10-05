const fakes = new Map([
  ['../core/hlClient.js', 'carry-hl-client-fake.js'],
  ['../core/config.js', 'carry-config-fake.js'],
]);

const helpers = new URL('.', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/modules/carry.js') && fakes.has(specifier)) {
    return { url: new URL(fakes.get(specifier), helpers).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
