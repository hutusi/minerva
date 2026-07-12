import { describe, expect, test } from "bun:test";
import { serveWithRetry } from "./fixtures/serve-retry";

describe("serveWithRetry", () => {
  test("binds and serves on the happy path", async () => {
    const server = await serveWithRetry({ port: 0, fetch: () => new Response("ok") });
    const response = await fetch(`http://localhost:${server.port}/`);
    expect(await response.text()).toBe("ok");
    await server.stop(true);
  });

  test("retries EADDRINUSE and wins once the port frees", async () => {
    const blocker = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    const port = blocker.port ?? Number.NaN;
    expect(Number.isInteger(port)).toBe(true);
    // Free the port after the first attempts have already failed.
    const release = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
      await blocker.stop(true);
    })();

    const server = await serveWithRetry({ port, fetch: () => new Response("won") }, 10);
    await release;
    expect(server.port).toBe(port);
    const response = await fetch(`http://localhost:${port}/`);
    expect(await response.text()).toBe("won");
    await server.stop(true);
  });

  test("exhausting the attempts rethrows the last EADDRINUSE", async () => {
    const blocker = Bun.serve({ port: 0, fetch: () => new Response("busy") });
    const port = blocker.port ?? Number.NaN;
    try {
      await serveWithRetry({ port, fetch: () => new Response("x") }, 2);
      throw new Error("expected serveWithRetry to reject");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("EADDRINUSE");
    } finally {
      await blocker.stop(true);
    }
  });

  test("non-EADDRINUSE bind failures rethrow immediately, without the backoff loop", async () => {
    const started = Date.now();
    try {
      // A unix socket in a nonexistent directory fails with ENOENT.
      await serveWithRetry(
        { unix: "/nonexistent-dir/minerva.sock", fetch: () => new Response("x") },
        5,
      );
      throw new Error("expected serveWithRetry to reject");
    } catch (error) {
      expect((error as { code?: string }).code).toBe("ENOENT");
    }
    // Five EADDRINUSE-style attempts would sleep ≥250 ms; a rethrow doesn't.
    expect(Date.now() - started).toBeLessThan(100);
  });
});
