import { describe, expect, test } from "bun:test";
import { createSidecarGenerationGate } from "../src/lib/sidecar-generation";

describe("createSidecarGenerationGate", () => {
  test("delivers only the active generation's exit", () => {
    const delivered: Array<number | null> = [];
    const gate = createSidecarGenerationGate((code) => delivered.push(code));
    gate.activate(2);
    gate.exit({ generation: 1, code: 1 });
    gate.exit({ generation: 2, code: 2 });
    expect(delivered).toEqual([2]);
  });

  test("an old exit received before activation is discarded", () => {
    const delivered: Array<number | null> = [];
    const gate = createSidecarGenerationGate((code) => delivered.push(code));
    gate.exit({ generation: 4, code: 4 });
    gate.activate(5);
    expect(delivered).toEqual([]);
  });

  test("an immediate exit is delivered once start identifies its generation", () => {
    const delivered: Array<number | null> = [];
    const gate = createSidecarGenerationGate((code) => delivered.push(code));
    gate.exit({ generation: 7, code: null });
    gate.activate(7);
    expect(delivered).toEqual([null]);
  });

  test("clear forgets ownership and buffered exits", () => {
    const delivered: Array<number | null> = [];
    const gate = createSidecarGenerationGate((code) => delivered.push(code));
    gate.exit({ generation: 9, code: 9 });
    gate.clear();
    gate.activate(9);
    expect(delivered).toEqual([]);
  });
});
