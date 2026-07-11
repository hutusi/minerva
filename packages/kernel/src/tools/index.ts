import { bashTool } from "./bash";
import { editFileTool } from "./edit-file";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readFileTool } from "./read-file";
import { todoTool } from "./todo";
import type { KernelTool } from "./types";
import { writeFileTool } from "./write-file";

export { locateRg, type RgEnv, resolveRgPath } from "./ripgrep";
export * from "./types";
export { bashTool, editFileTool, globTool, grepTool, readFileTool, todoTool, writeFileTool };

export function builtinTools(): KernelTool[] {
  return [readFileTool, writeFileTool, editFileTool, globTool, grepTool, bashTool, todoTool];
}
