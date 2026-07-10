import { describe, expect, test } from "bun:test";
import { parseCliArgs, usage } from "../src/args";

const DEFAULT = "claude-opus-4-8";

describe("parseCliArgs", () => {
  test("no arguments runs the TUI with defaults", () => {
    expect(parseCliArgs([], DEFAULT)).toEqual({
      kind: "run",
      args: { command: "tui", model: DEFAULT, resume: null },
    });
  });

  test("acp command and flags compose in any order", () => {
    expect(parseCliArgs(["acp", "-m", "openai/gpt-5.2"], DEFAULT)).toEqual({
      kind: "run",
      args: { command: "acp", model: "openai/gpt-5.2", resume: null },
    });
    expect(parseCliArgs(["-m", "openai/gpt-5.2", "acp"], DEFAULT)).toEqual({
      kind: "run",
      args: { command: "acp", model: "openai/gpt-5.2", resume: null },
    });
  });

  test("--continue and --resume set the resume target", () => {
    expect(parseCliArgs(["--continue"], DEFAULT)).toMatchObject({
      args: { resume: "latest" },
    });
    expect(parseCliArgs(["-r", "ses_abc"], DEFAULT)).toMatchObject({
      args: { resume: "ses_abc" },
    });
  });

  test("missing or flag-shaped values are errors, not silent misparses", () => {
    expect(parseCliArgs(["--resume"], DEFAULT)).toEqual({
      kind: "error",
      message: "--resume requires a session id",
    });
    expect(parseCliArgs(["-r", "--model", "x"], DEFAULT)).toMatchObject({ kind: "error" });
    expect(parseCliArgs(["--model"], DEFAULT)).toEqual({
      kind: "error",
      message: "--model requires a model id",
    });
    expect(parseCliArgs(["-m", "-c"], DEFAULT)).toMatchObject({ kind: "error" });
  });

  test("help and unknown options", () => {
    expect(parseCliArgs(["--help"], DEFAULT)).toEqual({ kind: "help" });
    expect(parseCliArgs(["-h"], DEFAULT)).toEqual({ kind: "help" });
    expect(parseCliArgs(["--wat"], DEFAULT)).toEqual({
      kind: "error",
      message: "unknown option: --wat",
    });
    // A second bare "acp" is not a valid option once the command is set.
    expect(parseCliArgs(["acp", "acp"], DEFAULT)).toMatchObject({ kind: "error" });
  });

  test("usage names the default model and every documented flag", () => {
    const text = usage(DEFAULT);
    expect(text).toContain("Usage: minerva");
    expect(text).toContain(DEFAULT);
    for (const flag of ["--continue", "--resume", "--model", "--help", "acp"]) {
      expect(text).toContain(flag);
    }
  });
});
