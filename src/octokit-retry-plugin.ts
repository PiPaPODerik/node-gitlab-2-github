import { Octokit } from '@octokit/core';
import { warn } from 'loglevel';
import { RetryConfig } from './utils';

/**
 * Sleep for the specified milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);
  // Add jitter: random value between 0 and cappedDelay
  return Math.random() * cappedDelay;
}

/**
 * Octokit plugin that adds retry logic with exponential backoff and jitter
 * for HTTP status codes 429, 500, 502, 503, 504
 */
export function retryPlugin(octokit: Octokit, options: { retry?: RetryConfig } = {}) {
  const retryConfig = {
    maxRetries: options.retry?.maxRetries ?? 5,
    baseDelayMs: options.retry?.baseDelayMs ?? 1000,
    maxDelayMs: options.retry?.maxDelayMs ?? 32000,
    retryableStatusCodes: options.retry?.retryableStatusCodes ?? [429, 500, 502, 503, 504],
  };

  /**
   * Check if the error should trigger a retry
   */
  function shouldRetry(error: any, attempt: number): boolean {
    if (attempt >= retryConfig.maxRetries) {
      return false;
    }

    const status = error?.status || error?.response?.status || error?.statusCode;
    return retryConfig.retryableStatusCodes.includes(status);
  }

  // Hook into the request lifecycle
  octokit.hook.wrap('request', async (request, options) => {
    let lastError: any;

    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      try {
        return await request(options);
      } catch (error: any) {
        lastError = error;

        if (!shouldRetry(error, attempt)) {
          throw error;
        }

        const delay = calculateDelay(attempt, retryConfig.baseDelayMs, retryConfig.maxDelayMs);
        const status = error?.status || error?.response?.status || error?.statusCode;

        warn(
          `GitHub API request failed with status ${status}. Retrying in ${Math.round(delay)}ms... ` +
          `(attempt ${attempt + 1}/${retryConfig.maxRetries}) [${options.method} ${options.url}]`
        );

        await sleep(delay);
      }
    }

    throw lastError;
  });
}
