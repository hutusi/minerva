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
    }
  | { kind: "plan"; entries: PlanEntry[] }
  | { kind: "info"; text: string };

export interface SessionViewModel {
  items: ViewItem[];
  busy: boolean;
  currentModeId?: string;
  /** Persistent status like currentModeId — not a transcript item. */
  usage?: { lastTurn?: TokenUsage | undefined; cumulative: TokenUsage };
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

  setBusy(busy: boolean): void {
    const items = busy ? this.#viewModel.items : this.#viewModel.items.map(finalizeStreamingItem);
    // Spread, don't rebuild: status state (currentModeId, usage) set while
    // the prompt was running must survive the busy flip at its end.
    this.#set({ ...this.#viewModel, items, busy });
  }

  apply(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.#appendStreamingText("assistant", update.content.text);
        break;
      case "user_message_chunk":
        this.addUserMessage(update.content.text);
        break;
      case "agent_thought_chunk":
        this.#appendStreamingText("thought", update.content.text);
        break;
      case "tool_call":
        this.#push({
          kind: "tool",
          toolCallId: update.toolCallId,
          title: update.title,
          toolKind: update.kind,
          status: update.status,
        });
        break;
      case "tool_call_update":
        this.#updateToolCall(update.toolCallId, (item) => ({
          ...item,
          status: update.status ?? item.status,
          title: update.title ?? item.title,
          output: extractText(update.content) ?? item.output,
        }));
        break;
      case "plan":
        this.#upsertPlan(update.entries);
        break;
      case "current_mode_update":
        this.setMode(update.currentModeId);
        break;
    }
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
    for (const update of updates) {
      const modeId = reduceInto(items, update);
      if (modeId !== undefined) currentModeId = modeId;
    }
    this.#set({
      ...this.#viewModel,
      items,
      ...(currentModeId !== undefined ? { currentModeId } : {}),
    });
  }

  setMode(modeId: string): void {
    this.#set({ ...this.#viewModel, currentModeId: modeId });
  }

  /** Latest wins; a resume announcement carries no lastTurn and clears it. */
  setUsage(lastTurn: TokenUsage | undefined, cumulative: TokenUsage): void {
    this.#set({ ...this.#viewModel, usage: { lastTurn, cumulative } });
  }

  /** One live plan per session: the latest update replaces it in place. */
  #upsertPlan(entries: PlanEntry[]): void {
    const items = [...this.#viewModel.items];
    upsertPlanInto(items, entries);
    this.#set({ ...this.#viewModel, items });
  }

  /** Shared by assistant text and thoughts: chunks coalesce into the last
   * item while it streams; a chunk of the other kind finalizes it first —
   * that switch is what collapses a thought when the answer starts. */
  #appendStreamingText(kind: "assistant" | "thought", text: string): void {
    const items = [...this.#viewModel.items];
    appendStreamingInto(items, kind, text);
    this.#set({ ...this.#viewModel, items });
  }

  #updateToolCall(
    toolCallId: string,
    change: (item: Extract<ViewItem, { kind: "tool" }>) => ViewItem,
  ): void {
    const items = [...this.#viewModel.items];
    updateToolCallInto(items, toolCallId, change);
    this.#set({ ...this.#viewModel, items });
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

/**
 * The item-array reductions below mutate the array they are given IN PLACE.
 * Callers pass a fresh clone (never a live snapshot), so the previously exposed
 * snapshot is never touched — that is what keeps updates immutable-safe while
 * letting a batch reuse one array across many updates.
 */
function reduceInto(items: ViewItem[], update: SessionUpdate): string | undefined {
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
      });
      return undefined;
    case "tool_call_update":
      updateToolCallInto(items, update.toolCallId, (item) => ({
        ...item,
        status: update.status ?? item.status,
        title: update.title ?? item.title,
        output: extractText(update.content) ?? item.output,
      }));
      return undefined;
    case "plan":
      upsertPlanInto(items, update.entries);
      return undefined;
    case "current_mode_update":
      return update.currentModeId;
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
