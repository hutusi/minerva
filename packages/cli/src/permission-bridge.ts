import type { PermissionHandler } from "@minerva/client";
import type { RequestPermissionParams, RequestPermissionResult } from "@minerva/protocol";

export interface PendingPermission {
  request: RequestPermissionParams;
  resolve: (result: RequestPermissionResult) => void;
}

export interface PermissionBridge {
  /** Assigned by the mounted UI; null while no UI is attached. */
  handler: PermissionHandler | null;
  onPermissionRequest: PermissionHandler;
}

/**
 * Hands kernel permission requests to the currently mounted UI. The client
 * is constructed before React renders, so the bridge decouples their
 * lifetimes; with no UI attached, requests resolve as cancelled (deny).
 */
export function createPermissionBridge(): PermissionBridge {
  const bridge: PermissionBridge = {
    handler: null,
    onPermissionRequest: (request) => {
      if (bridge.handler) return bridge.handler(request);
      return Promise.resolve({ outcome: { outcome: "cancelled" } });
    },
  };
  return bridge;
}
