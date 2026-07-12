import type {
  PlanEntry,
  SessionUpdate,
  TokenUsage,
  ToolCallContent,
  ToolCallStatus,
  ToolKind,
} from "@minerva/protocol";

/**
 * Session view-model (design decision #8): protocol updates in, renderable
 * state out, zero UI imports. The Ink CLI and the Tauri GUI both consume
 * this store, so rendering differences never leak into update handling.
 */

export type ViewItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | { kind: "thought"; text: string; streaming: boolean }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      output?: string | undefined;
      /** Tool input as the model sent it — permission prompts preview from it. */
      rawInput?: unknown;
      /** First diff block from the result, for UIs that render file changes. */
      diff?: { path: string; oldText: string | null; newText: string } | undefined;
    }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export interface SessionViewModel {
  items: ViewItem[];
  busy: boolean;
  currentModeId?: string;
  /** Persistent status like currentModeId — not a transcript item. */
  usage?: { lastTurn?: TokenUsage | undefined; cumulative: TokenUsage };
  /** Context-window utilization from ACP usage_update — status, not transcript. */
  context?: { used: number; size: number };
}

const EMPTY: SessionViewModel = { items: [], busy: false };

export class SessionStore {
  #viewModel: SessionViewModel = EMPTY;
  #listeners = new Set<() => void>();

  /** Stable snapshot for useSyncExternalStore-style consumers. */
  get snapshot(): SessionViewModel {
    return this.#viewModel;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  addUserMessage(text: string): void {
    this.#push({ kind: "user", text });
  }

  addInfo(text: string): void {
    this.#push({ kind: "info", text });
  }

  /** Frontend-side failures (rejected commands, transport errors) — styled
   * distinctly from informational notices. */
  addError(text: string): void {
    this.#push({ kind: "error", text });
  }

  setBusy(busy: boolean): void {
    const items = busy ? this.#viewModel.items : this.#viewModel.items.map(finalizeStreamingItem);
    // Spread, don't rebuild: status state (currentModeId, usage) set while
    // the prompt was running must survive the busy flip at its end.
    this.#set({ ...this.#viewModel, items, busy });
  }

  apply(update: SessionUpdate): void {
    // A batch of one: reduceInto is the single reducer, so the live path and
    // batched replay can never drift (this used to duplicate the whole
    // switch, and every new ViewItem field had to be added twice).
    this.applyBatch([update]);
  }

  /**
   * Apply many updates as one transition: build the items array on a single
   * clone (each update mutates it in place) and notify once. Used for session
   * replay, where applying updates one at a time re-cloned the whole transcript
   * per update — quadratic over a long session.
   */
  applyBatch(updates: SessionUpdate[]): void {
    const items = [...this.#viewModel.items];
    let currentModeId = this.#viewModel.currentModeId;
    let context = this.#viewModel.context;
    for (const update of updates) {
      const patch = reduceInto(items, update);
      if (patch?.modeId !== undefined) currentModeId = patch.modeId;
      if (patch?.context !== undefined) context = patch.context;
    }
    this.#set({
      ...this.#viewModel,
      items,
      ...(currentModeId !== undefined ? { currentModeId } : {}),
      ...(context !== undefined ? { context } : {}),
    });
  }

  setMode(modeId: string): void {
    this.#set({ ...this.#viewModel, currentModeId: modeId });
  }

  /** Latest wins; a resume announcement carries no lastTurn and clears it. */
  setUsage(lastTurn: TokenUsage | undefined, cumulative: TokenUsage): void {
    this.#set({ ...this.#viewModel, usage: { lastTurn, cumulative } });
  }

  #push(item: ViewItem): void {
    const items = [...this.#viewModel.items];
    pushInto(items, item);
    this.#set({ ...this.#viewModel, items });
  }

  #set(viewModel: SessionViewModel): void {
    this.#viewModel = viewModel;
    for (const listener of this.#listeners) listener();
  }
}

/** Non-transcript state an update carries — merged onto the view model. */
interface StatusPatch {
  modeId?: string;
  context?: { used: number; size: number };
}

/**
 * The item-array reductions below mutate the array they are given IN PLACE.
 * Callers pass a fresh clone (never a live snapshot), so the previously exposed
 * snapshot is never touched — that is what keeps updates immutable-safe while
 * letting a batch reuse one array across many updates.
 */
function reduceInto(items: ViewItem[], update: SessionUpdate): StatusPatch | undefined {
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      appendStreamingInto(items, "assistant", update.content.text);
      return undefined;
    case "user_message_chunk":
      pushInto(items, { kind: "user", text: update.content.text });
      return undefined;
    case "agent_thought_chunk":
      appendStreamingInto(items, "thought", update.content.text);
      return undefined;
    case "tool_call":
      pushInto(items, {
        kind: "tool",
        toolCallId: update.toolCallId,
        title: update.title,
        toolKind: update.kind,
        status: update.status,
        ...("rawInput" in update ? { rawInput: update.rawInput } : {}),
      });
      return undefined;
    case "tool_call_update":
      updateToolCallInto(items, update.toolCallId, (item) => ({
        ...item,
        status: update.status ?? item.status,
        title: update.title ?? item.title,
        output: extractText(update.content) ?? item.output,
        diff: extractDiff(update.content) ?? item.diff,
      }));
      return undefined;
    case "plan":
      upsertPlanInto(items, update.entries);
      return undefined;
    case "current_mode_update":
      return { modeId: update.currentModeId };
    case "usage_update":
      return { context: { used: update.used, size: update.size } };
  }
}

function appendStreamingInto(items: ViewItem[], kind: "assistant" | "thought", text: string): void {
  const last = items[items.length - 1];
  if (last?.kind === kind && last.streaming) {
    items[items.length - 1] = { ...last, text: last.text + text };
    return;
  }
  pushInto(items, { kind, text, streaming: true });
}

function pushInto(items: ViewItem[], item: ViewItem): void {
  // A non-assistant/other-kind item ends the current streamed message; only the
  // tail can be streaming, so finalize it in place before appending.
  const lastIndex = items.length - 1;
  const last = items[lastIndex];
  if (last && (last.kind === "assistant" || last.kind === "thought") && last.streaming) {
    items[lastIndex] = { ...last, streaming: false };
  }
  items.push(item);
}

function updateToolCallInto(
  items: ViewItem[],
  toolCallId: string,
  change: (item: Extract<ViewItem, { kind: "tool" }>) => ViewItem,
): void {
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item?.kind === "tool" && item.toolCallId === toolCallId) items[i] = change(item);
  }
}

function upsertPlanInto(items: ViewItem[], entries: PlanEntry[]): void {
  const existing = items.findIndex((item) => item.kind === "plan");
  if (existing === -1) pushInto(items, { kind: "plan", entries });
  else items[existing] = { kind: "plan", entries };
}

function finalizeStreamingItem(item: ViewItem): ViewItem {
  return (item.kind === "assistant" || item.kind === "thought") && item.streaming
    ? { ...item, streaming: false }
    : item;
}

function extractText(content: ToolCallContent[] | undefined): string | undefined {
  if (!content) return undefined;
  const texts = content
    .map((entry) => (entry.type === "content" ? entry.content.text : undefined))
    .filter((text): text is string => typeof text === "string");
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function extractDiff(
  content: ToolCallContent[] | undefined,
): Extract<ViewItem, { kind: "tool" }>["diff"] {
  const entry = content?.find((block) => block.type === "diff");
  if (entry?.type !== "diff") return undefined;
  return { path: entry.path, oldText: entry.oldText, newText: entry.newText };
}
