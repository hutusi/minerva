import { open } from "@tauri-apps/plugin-dialog";

/** Native folder picker; null when the user cancels. */
export async function pickFolder(): Promise<string | null> {
  const choice = await open({ directory: true, multiple: false, title: "Open project folder" });
  return typeof choice === "string" ? choice : null;
}
