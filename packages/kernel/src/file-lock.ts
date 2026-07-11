/**
 * Serialize read-modify-write on a single file across concurrent callers.
 *
 * Several kernel operations do unlocked read → mutate → write on shared files
 * (settings.json on an "allow always" approval, the session index on
 * create/resume). Two of them interleaving would lose one side's change —
 * last-writer-wins. A per-path promise chain (the same trick Session uses for
 * its append log) forces same-file writers to run one at a time. Writers of
 * different files never contend; the chain is keyed by the resolved path.
 */

import { resolve } from "node:path";

const locks = new Map<string, Promise<void>>();

export function withFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
  const key = resolve(path);
  const prev = locks.get(key) ?? Promise.resolve();
  // Run after the previous holder settles, success or failure alike.
  const run = prev.then(task, task);
  // A settled-tolerant tail so one caller's rejection can't stall the queue.
  const tail = run.then(
    () => {},
    () => {},
  );
  locks.set(key, tail);
  void tail.then(() => {
    // Drop the entry once the queue drains, so the map doesn't grow forever.
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}
