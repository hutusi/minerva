import type { ViewItem } from "@minerva/client";

const MARK = { pending: "☐", in_progress: "◐", completed: "☑" } as const;

export function PlanItem({ entries }: { entries: Extract<ViewItem, { kind: "plan" }>["entries"] }) {
  return (
    <div className="text-sm">
      <div className="font-medium">Todos</div>
      {withUniqueKeys(entries).map(({ entry, key }) => (
        <div
          key={key}
          className={
            entry.status === "in_progress"
              ? "text-yellow-600 dark:text-yellow-400"
              : entry.status === "completed"
                ? "text-muted-foreground line-through"
                : ""
          }
        >
          {MARK[entry.status]} {entry.content}
        </div>
      ))}
    </div>
  );
}

/** Stable-ish keys from content, disambiguating duplicate entries. */
function withUniqueKeys<T extends { content: string }>(
  entries: T[],
): Array<{ entry: T; key: string }> {
  const seen = new Map<string, number>();
  return entries.map((entry) => {
    const count = seen.get(entry.content) ?? 0;
    seen.set(entry.content, count + 1);
    return { entry, key: count === 0 ? entry.content : `${entry.content}#${count}` };
  });
}
