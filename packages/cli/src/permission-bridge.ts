import type { PermissionHandler } from "@minerva/client";
import type { RequestPermissionParams, RequestPermissionResult } from "@minerva/protocol";

export interface PendingPermission {
  request: RequestPermissionParams;
  resolve: (result: RequestPermissionResult) => void;
}

/**
 * Hands kernel permission requests to the currently mounted UI. The client
 * is constructed before React renders, so the bridge decouples their
 * lifetimes; with no UI attached, requests resolve as cancelled (deny).
 */
export class PermissionBridge {
  handler: PermissionHandler | null = null;

  readonly onPermissionRequest: PermissionHandler = (request) => {
    if (this.handler) return this.handler(request);
    return Promise.resolve({ outcome: { outcome: "cancelled" } });
  };
}
