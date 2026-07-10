import { bashTool } from "./bash";
import { editFileTool } from "./edit-file";
import { readFileTool } from "./read-file";
import type { KernelTool } from "./types";

export * from "./types";
export { bashTool, editFileTool, readFileTool };

export function builtinTools(): KernelTool[] {
  return [readFileTool, editFileTool, bashTool];
}
