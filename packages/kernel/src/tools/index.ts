import { bashTool } from "./bash";
import { editFileTool } from "./edit-file";
import { globTool } from "./glob";
import { grepTool } from "./grep";
import { readFileTool } from "./read-file";
import { todoTool } from "./todo";
import type { KernelTool } from "./types";
import { webFetchTool } from "./web-fetch";
import { writeFileTool } from "./write-file";

export { locateRg, type RgEnv, resolveRgPath } from "./ripgrep";
export { createSkillTool } from "./skill";
export * from "./types";
export { htmlToText, webFetchTool } from "./web-fetch";
export { bashTool, editFileTool, globTool, grepTool, readFileTool, todoTool, writeFileTool };

export function builtinTools(): KernelTool[] {
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    globTool,
    grepTool,
    bashTool,
    todoTool,
    webFetchTool,
  ];
}
