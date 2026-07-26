'use strict';

function calculateBackoff(attempt, options = {}) {
  const initialMs = options.initialMs ?? 750;
  const maximumMs = options.maximumMs ?? 12_000;
  const jitterRatio = options.jitterRatio ?? 0.15;
  const random = options.random || Math.random;
  const base = Math.min(maximumMs, initialMs * (2 ** Math.max(0, attempt - 1)));
  const jitter = base * jitterRatio * ((random() * 2) - 1);
  return Math.max(0, Math.round(base + jitter));
}

async function retryWithBackoff(operation, options = {}) {
  const retries = options.retries ?? 3;
  const sleep = options.sleep || ((milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const shouldRetry = options.shouldRetry || ((error) => Boolean(error?.temporary));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation(attempt + 1);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) throw error;
      const calculated = calculateBackoff(attempt + 1, options);
      const waitMs = Math.max(calculated, Number(error?.retryAfterMs) || 0);
      if (typeof options.onRetry === 'function') {
        await options.onRetry({ attempt: attempt + 1, waitMs, error });
      }
      await sleep(waitMs);
    }
  }
}

module.exports = {
  calculateBackoff,
  retryWithBackoff,
};
