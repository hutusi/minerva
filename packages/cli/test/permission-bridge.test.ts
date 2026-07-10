import { describe, expect, test } from "bun:test";
import { createPermissionBridge } from "../src/permission-bridge";

const REQUEST = {
  sessionId: "ses_x",
  toolCall: { toolCallId: "c1", title: "rm -rf /", kind: "execute" as const },
  options: [],
};

describe("PermissionBridge", () => {
  test("with no UI attached, requests resolve as cancelled (deny)", async () => {
    const bridge = createPermissionBridge();
    await expect(bridge.onPermissionRequest(REQUEST)).resolves.toEqual({
      outcome: { outcome: "cancelled" },
    });
  });

  test("delegates to the mounted UI handler when present", async () => {
    const bridge = createPermissionBridge();
    bridge.handler = async () => ({ outcome: { outcome: "selected", optionId: "allow" } });
    await expect(bridge.onPermissionRequest(REQUEST)).resolves.toEqual({
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });
});
