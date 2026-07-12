/**
 * Bun.serve with a bind retry. Full-suite runs occasionally hit EADDRINUSE
 * even though every test binds port 0 — a re-bind race after force-stopping
 * many servers in one process (`stop(true)` everywhere, no reusePort). A few
 * retries with a short growing pause absorb the race; any other error — or
 * exhaustion — still throws so real failures stay loud.
 */

type ServeOptions = Parameters<typeof Bun.serve>[0];

export async function serveWithRetry(options: ServeOptions, attempts = 5) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return Bun.serve(options);
    } catch (error) {
      if ((error as { code?: string } | null)?.code !== "EADDRINUSE") throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
  throw lastError;
}
