import type { ModelProvider, TurnEvent } from "./types";

/**
 * Deterministic provider for tests: plays back one scripted event sequence
 * per turn, in order. Lets kernel and end-to-end tests drive the full agent
 * loop (including tool calls) without any network or AI SDK involvement.
 */
export function createScriptedProvider(turns: TurnEvent[][]): ModelProvider {
  let turnIndex = 0;
  return {
    id: "scripted",
    async *streamTurn() {
      const turn = turns[turnIndex];
      if (!turn) {
        throw new Error(`scripted provider exhausted after ${turnIndex} turns`);
      }
      turnIndex += 1;
      yield* turn;
    },
  };
}
