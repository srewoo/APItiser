/**
 * Rate-limit awareness for GitHub and GitLab API calls.
 * Reads rate-limit headers and sleeps until reset when needed.
 */

const sleepMs = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Checks the rate-limit headers for GitHub API responses.
 * If remaining requests = 0, sleeps until the reset time.
 */
export const checkGitHubRateLimit = async (headers: Headers): Promise<void> => {
  const remaining = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');

  if (remaining !== null && Number(remaining) <= 0 && reset) {
    const resetEpochMs = Number(reset) * 1000;
    const now = Date.now();
    const waitMs = Math.max(resetEpochMs - now + 1000, 0); // +1s buffer
    if (waitMs > 0) {
      console.warn(`[APItiser] GitHub rate limit hit. Sleeping ${Math.round(waitMs / 1000)}s until reset.`);
      await sleepMs(waitMs);
    }
  }
};

/**
 * Checks rate-limit headers for GitLab API responses.
 * If remaining = 0, uses Retry-After or falls back to 60s.
 */
export const checkGitLabRateLimit = async (headers: Headers): Promise<void> => {
  const remaining = headers.get('ratelimit-remaining');
  const retryAfter = headers.get('retry-after');

  if (remaining !== null && Number(remaining) <= 0) {
    const waitMs = retryAfter ? Number(retryAfter) * 1000 : 60_000;
    console.warn(`[APItiser] GitLab rate limit hit. Sleeping ${Math.round(waitMs / 1000)}s.`);
    await sleepMs(waitMs);
  }
};
