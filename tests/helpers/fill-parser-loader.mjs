
const fakeBySpecifier = new Map([
  ['../../core/universe.js', 'fill-parser-universe-fake.js'],
  ['./state.js', 'fill-parser-state-fake.js'],
  ['../../core/logger.js', 'fill-parser-logger-fake.js'],
]);
const helpers = new URL('.', import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.endsWith('/src/modules/executor/fill-parser.js') && fakeBySpecifier.has(specifier)) {
    return { url: new URL(fakeBySpecifier.get(specifier), helpers).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
