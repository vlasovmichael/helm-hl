export const config = { trading: { dailyLossLimitUsd: 5, dailyLossLimitEnabled: true, dailyFeeBudgetPct: 1.5 } };
export function resetConfig() { Object.assign(config.trading, { dailyLossLimitUsd: 5, dailyLossLimitEnabled: true, dailyFeeBudgetPct: 1.5 }); }
