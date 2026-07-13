import { clipDiff, type DiffLine, diffLines } from "@minerva/client";
import { useMemo, useState } from "react";
import { alignDiffRows, type SplitCell } from "../../lib/diff-rows";

/** Cap on rendered diff lines — same budget as the TUI transcript. */
const DIFF_LINE_CAP = 20;

/** Shared viewer preference; each DiffView initializes from it on mount. */
const VIEW_KEY = "minerva.diffView.v1";

function loadPreference(): "unified" | "split" {
  return localStorage.getItem(VIEW_KEY) === "split" ? "split" : "unified";
}

export function DiffView({ diff }: { diff: { oldText: string | null; newText: string } }) {
  const [view, setView] = useState(loadPreference);
  // The LCS diff is quadratic in the changed region — memoize it, or every
  // streaming token re-renders re-diff every edit in the transcript.
  const lines = useMemo(
    () => clipDiff(diffLines(diff.oldText, diff.newText), DIFF_LINE_CAP),
    [diff.oldText, diff.newText],
  );

  const toggle = (next: "unified" | "split") => {
    localStorage.setItem(VIEW_KEY, next);
    setView(next);
  };

  return (
    <div className="mt-1 overflow-x-auto rounded-md border bg-muted/30 font-mono text-xs">
      <div className="flex justify-end gap-1 border-b px-1 py-0.5 font-sans">
        {(["unified", "split"] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => toggle(option)}
            className={`rounded px-1.5 py-0.5 text-[10px] ${
              view === option
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/50"
            }`}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="py-1">
        {view === "split" ? <SplitDiff lines={lines} /> : <UnifiedDiff lines={lines} />}
      </div>
    </div>
  );
}

function UnifiedDiff({ lines }: { lines: DiffLine[] }) {
  // Same key scheme as the TUI: character offset disambiguates equal lines.
  let offset = 0;
  return (
    <>
      {lines.map((line) => {
        const key = `${offset}:${line.kind}`;
        offset += line.text.length + 1;
        return <UnifiedRow key={key} line={line} />;
      })}
    </>
  );
}

function UnifiedRow({ line }: { line: DiffLine }) {
  switch (line.kind) {
    case "add":
      return (
        <div className="whitespace-pre bg-green-500/10 px-2 text-green-700 dark:text-green-400">
          + {line.text}
        </div>
      );
    case "del":
      return (
        <div className="whitespace-pre bg-red-500/10 px-2 text-red-700 dark:text-red-400">
          - {line.text}
        </div>
      );
    case "gap":
    case "note":
      return <div className="whitespace-pre px-2 text-muted-foreground italic">{line.text}</div>;
    default:
      return <div className="whitespace-pre px-2 text-muted-foreground"> {line.text}</div>;
  }
}

const CELL_STYLE: Record<SplitCell["kind"], string> = {
  context: "text-muted-foreground",
  add: "bg-green-500/10 text-green-700 dark:text-green-400",
  del: "bg-red-500/10 text-red-700 dark:text-red-400",
  empty: "bg-muted/40",
};

function SplitDiff({ lines }: { lines: DiffLine[] }) {
  const rows = useMemo(() => alignDiffRows(lines), [lines]);
  let offset = 0;
  return (
    <div className="grid grid-cols-2">
      {rows.flatMap((row) => {
        const key = `${offset}`;
        offset +=
          row.kind === "band"
            ? row.text.length + 1
            : row.left.text.length + row.right.text.length + 2;
        if (row.kind === "band") {
          return [
            <div key={key} className="col-span-2 whitespace-pre px-2 text-muted-foreground italic">
              {row.text}
            </div>,
          ];
        }
        return [
          <div
            key={`${key}L`}
            className={`whitespace-pre border-r px-2 ${CELL_STYLE[row.left.kind]}`}
          >
            {row.left.text || " "}
          </div>,
          <div key={`${key}R`} className={`whitespace-pre px-2 ${CELL_STYLE[row.right.kind]}`}>
            {row.right.text || " "}
          </div>,
        ];
      })}
    </div>
  );
}
