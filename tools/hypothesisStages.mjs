export const STAGE_KIND = Object.freeze({
  DEVELOPMENT: "development",
  HOLDOUT: "holdout",
  FORWARD: "forward",
});

export const STAGE_ORDER = Object.freeze([
  STAGE_KIND.DEVELOPMENT,
  STAGE_KIND.HOLDOUT,
  STAGE_KIND.FORWARD,
]);

export function resolveStageBranch(registry, hypothesisId) {
  const hypotheses = new Map(registry.hypotheses.map((row) => [row.id, row]));
  if (!hypotheses.has(hypothesisId)) throw new Error(`гипотеза «${hypothesisId}» не зарегистрирована`);
  const outgoing = new Map((registry.stageLinks ?? []).map((row) => [row.fromHypothesisId, row]));
  const chain = [];
  const seen = new Set();
  let currentId = hypothesisId;

  while (true) {
    if (seen.has(currentId)) throw new Error(`цикл стадий у гипотезы «${hypothesisId}»`);
    seen.add(currentId);
    chain.push(currentId);
    const link = outgoing.get(currentId);
    if (!link) break;
    if (!hypotheses.has(link.toHypothesisId)) {
      throw new Error(`следующая стадия «${link.toHypothesisId}» не зарегистрирована`);
    }
    currentId = link.toHypothesisId;
  }

  return {
    hypothesisId,
    terminalHypothesisId: currentId,
    chain,
    terminalHypothesis: hypotheses.get(currentId),
  };
}
