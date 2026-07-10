import type { SessionUpdate, ToolCallContent, ToolCallStatus, ToolKind } from "@minerva/protocol";

/**
 * Session view-model (design decision #8): protocol updates in, renderable
 * state out, zero UI imports. The Ink CLI and the Tauri GUI both consume
 * this store, so rendering differences never leak into update handling.
 */

export type ViewItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; streaming: boolean }
  | {
      kind: "tool";
      toolCallId: string;
      title: string;
      toolKind: ToolKind;
      status: ToolCallStatus;
      output?: string;
    }
  | { kind: "info"; text: string };

export interface SessionViewModel {
  items: ViewItem[];
  busy: boolean;
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
    this.#set({ items, busy });
  }

  apply(update: SessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.#appendAssistantText(update.content.text);
        break;
      case "user_message_chunk":
        this.addUserMessage(update.content.text);
        break;
      case "agent_thought_chunk":
        // Not surfaced in slice 1.
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
    }
  }

  #appendAssistantText(text: string): void {
    const items = [...this.#viewModel.items];
    const last = items[items.length - 1];
    if (last?.kind === "assistant" && last.streaming) {
      items[items.length - 1] = { ...last, text: last.text + text };
    } else {
      items.push({ kind: "assistant", text, streaming: true });
    }
    this.#set({ ...this.#viewModel, items });
  }

  #updateToolCall(
    toolCallId: string,
    change: (item: Extract<ViewItem, { kind: "tool" }>) => ViewItem,
  ): void {
    const items = this.#viewModel.items.map((item) =>
      item.kind === "tool" && item.toolCallId === toolCallId ? change(item) : item,
    );
    this.#set({ ...this.#viewModel, items });
  }

  #push(item: ViewItem): void {
    // A non-assistant item ends the current streamed message: the next
    // agent_message_chunk starts a fresh block after the tool call.
    const items = [...this.#viewModel.items.map(finalizeStreamingItem), item];
    this.#set({ ...this.#viewModel, items });
  }

  #set(viewModel: SessionViewModel): void {
    this.#viewModel = viewModel;
    for (const listener of this.#listeners) listener();
  }
}

function finalizeStreamingItem(item: ViewItem): ViewItem {
  return item.kind === "assistant" && item.streaming ? { ...item, streaming: false } : item;
}

function extractText(content: ToolCallContent[] | undefined): string | undefined {
  if (!content) return undefined;
  const texts = content
    .map((entry) => (entry.type === "content" ? entry.content.text : undefined))
    .filter((text): text is string => typeof text === "string");
  return texts.length > 0 ? texts.join("\n") : undefined;
}
