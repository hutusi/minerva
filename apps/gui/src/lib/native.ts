import { open } from "@tauri-apps/plugin-dialog";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

/** Native folder picker; null when the user cancels. */
export async function pickFolder(): Promise<string | null> {
  const choice = await open({ directory: true, multiple: false, title: "Open project folder" });
  return typeof choice === "string" ? choice : null;
}

/** Deliver a native notification, asking the OS for permission on first use.
 * Best-effort: denial, an unsupported platform, or a plugin error are all
 * silence, never a rejection — callers fire-and-forget this. */
export async function notify(title: string, body: string): Promise<void> {
  try {
    let granted = await isPermissionGranted();
    if (!granted) {
      granted = (await requestPermission()) === "granted";
    }
    if (granted) sendNotification({ title, body });
  } catch {
    // Silence by contract.
  }
}
