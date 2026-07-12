import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Markdown } from "../src/markdown";

const frame = (text: string): string => {
  const ui = render(<Markdown text={text} />);
  const output = ui.lastFrame() ?? "";
  ui.unmount();
  return output;
};

describe("Markdown block tokens", () => {
  test("headings keep their text and drop the # markers", () => {
    const output = frame("# Top\n\n### Deep");
    expect(output).toContain("Top");
    expect(output).toContain("Deep");
    expect(output).not.toContain("#");
  });

  test("fenced code renders indented with a language label", () => {
    const output = frame("```ts\nconst x = 1;\n\nreturn x;\n```");
    expect(output).toContain("ts");
    expect(output).toContain("  const x = 1;");
    expect(output).toContain("  return x;");
    expect(output).not.toContain("```");
  });

  test("fenced code without a language still renders its lines", () => {
    expect(frame("```\nplain\n```")).toContain("  plain");
  });

  test("unordered lists use bullets and recurse into nesting", () => {
    const output = frame("- alpha\n- beta\n  - nested");
    expect(output).toContain("• alpha");
    expect(output).toContain("• beta");
    expect(output).toContain("  • nested");
  });

  test("ordered lists number from the token's start", () => {
    const output = frame("3. three\n4. four");
    expect(output).toContain("3. three");
    expect(output).toContain("4. four");
  });

  test("loose list items are separated by a blank line", () => {
    const output = frame("- alpha\n\n- beta");
    expect(output).toContain("• alpha\n\n• beta");
  });

  test("blockquotes carry a gutter mark and render inline styles", () => {
    const output = frame("> quoted *words*");
    expect(output).toContain("▎ quoted words");
  });

  test("horizontal rules draw a line", () => {
    expect(frame("---")).toContain("─".repeat(40));
  });

  test("paragraphs separated by a blank line stay separated", () => {
    expect(frame("one\n\ntwo")).toBe("one\n\ntwo");
  });

  test("tables fall back to their raw source, never dropped", () => {
    const table = "| a | b |\n|---|---|\n| 1 | 2 |";
    expect(frame(table)).toContain("| a | b |");
  });
});

describe("Markdown inline tokens", () => {
  test("strong, em, del, and codespan keep their text without markers", () => {
    const output = frame("**bold** *ital* ~~gone~~ `code < span`");
    expect(output).toContain("bold ital gone code < span");
    expect(output).not.toContain("*");
    expect(output).not.toContain("~");
    expect(output).not.toContain("`");
  });

  test("links show the href when it differs from the text", () => {
    expect(frame("[docs](https://example.dev)")).toContain("docs (https://example.dev)");
  });

  test("autolinks don't repeat the href", () => {
    const output = frame("<https://example.dev>");
    expect(output).toContain("https://example.dev");
    expect(output).not.toContain("(https://example.dev)");
  });

  test("escapes render the escaped character", () => {
    expect(frame("\\*not bold\\*")).toContain("*not bold*");
  });

  test("inline html falls back to raw", () => {
    expect(frame("a <kbd>x</kbd> key")).toContain("a <kbd>x</kbd> key");
  });
});

describe("Markdown streaming and guards", () => {
  test("a partial stream with an unterminated marker still renders", () => {
    const output = frame("Working on **someth");
    expect(output).toContain("Working on");
    expect(output).toContain("someth");
  });

  test("a partial fence self-heals as a code block", () => {
    expect(frame("```ts\nconst x =")).toContain("const x =");
  });

  test("oversize text skips lexing and renders plain", () => {
    const output = frame(`# huge\n\n${"x".repeat(51_000)}`);
    expect(output).toContain("# huge");
  });
});
