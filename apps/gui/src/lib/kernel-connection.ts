import { MinervaClient, type MinervaClientOptions } from "@minerva/client";
import type { SidecarBridge } from "./sidecar-bridge";
import { createSidecarTransport } from "./tauri-transport";

/**
 * Spawn (or attach to) the kernel and return an initialized client. Kept
 * separate from React so connection lifecycle never depends on render
 * lifecycle — StrictMode double-effects and HMR reloads call this again and
 * simply attach to the already-running kernel.
 */
export async function connectKernel(
  bridge: SidecarBridge,
  options: MinervaClientOptions = {},
): Promise<MinervaClient> {
  await bridge.start();
  const client = new MinervaClient(createSidecarTransport(bridge), options);
  await client.initialize();
  return client;
}
