import type { DiffLine } from "@minerva/client";

/**
 * Side-by-side alignment over the shared unified diff: old file on the left,
 * new on the right. Within each changed region, the i-th removed line faces
 * the i-th added line (the classic split-view pairing); the longer side
 * finishes against blanks. Gap/note lines become full-width bands.
 */

export interface SplitCell {
  kind: "context" | "add" | "del" | "empty";
  text: string;
}

export type SplitRow =
  | { kind: "pair"; left: SplitCell; right: SplitCell }
  | { kind: "band"; text: string };

const EMPTY: SplitCell = { kind: "empty", text: "" };

export function alignDiffRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: string[] = [];
  let adds: string[] = [];

  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const del = dels[i];
      const add = adds[i];
      rows.push({
        kind: "pair",
        left: del !== undefined ? { kind: "del", text: del } : EMPTY,
        right: add !== undefined ? { kind: "add", text: add } : EMPTY,
      });
    }
    dels = [];
    adds = [];
  };

  for (const line of lines) {
    switch (line.kind) {
      case "del":
        dels.push(line.text);
        break;
      case "add":
        adds.push(line.text);
        break;
      case "context":
        flush();
        rows.push({
          kind: "pair",
          left: { kind: "context", text: line.text },
          right: { kind: "context", text: line.text },
        });
        break;
      default: // gap | note
        flush();
        rows.push({ kind: "band", text: line.text });
        break;
    }
  }
  flush();
  return rows;
}
