export const config = { trading: { closeLimitWaitMs: 1, closeLimitPollMs: 0 } };
export function setTiming({ waitMs = 1, pollMs = 0 } = {}) {
  config.trading.closeLimitWaitMs = waitMs;
  config.trading.closeLimitPollMs = pollMs;
}
