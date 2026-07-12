import { clipDiff, type DiffLine, diffLines } from "@minerva/client";

/** Cap on rendered diff lines — same budget as the TUI transcript. */
const DIFF_LINE_CAP = 20;

export function DiffView({ diff }: { diff: { oldText: string | null; newText: string } }) {
  const lines = clipDiff(diffLines(diff.oldText, diff.newText), DIFF_LINE_CAP);
  // Same key scheme as the TUI: character offset disambiguates equal lines.
  let offset = 0;
  return (
    <div className="mt-1 overflow-x-auto rounded-md border bg-muted/30 py-1 font-mono text-xs">
      {lines.map((line) => {
        const key = `${offset}:${line.kind}`;
        offset += line.text.length + 1;
        return <DiffRow key={key} line={line} />;
      })}
    </div>
  );
}

function DiffRow({ line }: { line: DiffLine }) {
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
