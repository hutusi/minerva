import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MinervaClient } from "@minerva/client";
import { createKernel, type MinervaKernel } from "@minerva/kernel";
import { createInProcTransportPair } from "@minerva/protocol";
import { createScriptedProvider } from "@minerva/providers";
import { ensureTabSession, isStaleSessionError } from "../src/lib/tab-session";

/**
 * The stale predicate is only as good as the errors the kernel actually
 * throws — an earlier version matched a message the load path never
 * produces, silently disabling the self-heal. These tests run the REAL
 * kernel so the predicate can't drift from the wire again.
 */
describe("isStaleSessionError against the real kernel", () => {
  const kernels: MinervaKernel[] = [];
  const clients: MinervaClient[] = [];
  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await Promise.all(kernels.splice(0).map((kernel) => kernel.close()));
  });

  async function setup() {
    const cwd = mkdtempSync(join(tmpdir(), "minerva-gui-stale-proj-"));
    const dataDir = mkdtempSync(join(tmpdir(), "minerva-gui-stale-data-"));
    const [clientTransport, kernelTransport] = createInProcTransportPair();
    kernels.push(createKernel(kernelTransport, { dataDir, provider: createScriptedProvider([]) }));
    const client = new MinervaClient(clientTransport);
    clients.push(client);
    await client.initialize();
    return { client, cwd };
  }

  const caught = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (cause: unknown) => cause,
    );

  test("a missing persisted session is stale (deleted log, other data dir)", async () => {
    const { client, cwd } = await setup();
    const error = await caught(client.loadSession(`ses_${crypto.randomUUID()}`, cwd));
    expect(error).not.toBeNull();
    expect(isStaleSessionError(error)).toBe(true);
  });

  test("a corrupt persisted id is stale", async () => {
    const { client, cwd } = await setup();
    const error = await caught(client.loadSession("../../etc/passwd", cwd));
    expect(error).not.toBeNull();
    expect(isStaleSessionError(error)).toBe(true);
  });

  test("ensureTabSession self-heals a dead tab id end to end", async () => {
    const { client, cwd } = await setup();
    const { session, resumed } = await ensureTabSession(
      {
        load: (sessionId, dir) => client.loadSession(sessionId, dir),
        create: (dir) => client.newSession(dir),
      },
      { id: "t", cwd, sessionId: `ses_${crypto.randomUUID()}` },
      isStaleSessionError,
    );
    expect(resumed).toBe(false);
    expect(session.sessionId).toStartWith("ses_");
  });
});
