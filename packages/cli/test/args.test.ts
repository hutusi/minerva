import { describe, expect, test } from "bun:test";
import { parseCliArgs, usage } from "../src/args";

describe("parseCliArgs", () => {
  test("no arguments runs the TUI with no model override", () => {
    expect(parseCliArgs([])).toEqual({
      kind: "run",
      args: { command: "tui", model: null, resume: null },
    });
  });

  test("acp command and flags compose in any order", () => {
    expect(parseCliArgs(["acp", "-m", "openai/gpt-5.2"])).toEqual({
      kind: "run",
      args: { command: "acp", model: "openai/gpt-5.2", resume: null },
    });
    expect(parseCliArgs(["-m", "openai/gpt-5.2", "acp"])).toEqual({
      kind: "run",
      args: { command: "acp", model: "openai/gpt-5.2", resume: null },
    });
  });

  test("--continue and --resume set the resume target", () => {
    expect(parseCliArgs(["--continue"])).toMatchObject({
      args: { resume: "latest" },
    });
    expect(parseCliArgs(["-r", "ses_abc"])).toMatchObject({
      args: { resume: "ses_abc" },
    });
  });

  test("missing or flag-shaped values are errors, not silent misparses", () => {
    expect(parseCliArgs(["--resume"])).toEqual({
      kind: "error",
      message: "--resume requires a session id",
    });
    expect(parseCliArgs(["-r", "--model", "x"])).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["--model"])).toEqual({
      kind: "error",
      message: "--model requires a model id",
    });
    expect(parseCliArgs(["-m", "-c"])).toMatchObject({ kind: "error" });
  });

  test("help and unknown options", () => {
    expect(parseCliArgs(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"])).toEqual({ kind: "help" });
    expect(parseCliArgs(["--wat"])).toEqual({
      kind: "error",
      message: "unknown option: --wat",
    });
    // A second bare "acp" is not a valid option once the command is set.
    expect(parseCliArgs(["acp", "acp"])).toMatchObject({ kind: "error" });
  });

  test("usage names the default model and every documented flag", () => {
    const DEFAULT = "claude-opus-4-8";
    const text = usage(DEFAULT);
    expect(text).toContain("Usage: minerva");
    expect(text).toContain(DEFAULT);
    for (const flag of ["--continue", "--resume", "--model", "--help", "acp"]) {
      expect(text).toContain(flag);
    }
    for (const keyVar of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "DASHSCOPE_API_KEY"]) {
      expect(text).toContain(keyVar);
    }
    expect(text).toContain("/config");
  });
});
