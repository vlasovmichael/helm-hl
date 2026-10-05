const here = new URL('./', import.meta.url);
const imports = new Set([
  '../../core/logger.js', '../../core/retry.js', '../../core/database.js', '../exchange.js',
  './fill-parser.js', './limitClose.js', '../userFills.js', './math.js', '../../core/config.js',
  './state.js', './reconciler.js', './hooks.js', '../strategistAdopt.js',
  '../adoptShadowTimeCut.js', '../adoptShadowTrail.js', './notifications.js',
]);

export async function resolve(specifier, context, nextResolve) {
  if (process.env.CLOSE_FAKE_DEPS === '1' && context.parentURL?.endsWith('/src/modules/executor/close.js') && imports.has(specifier)) {
    return { url: new URL('close-deps-fake.js', here).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
