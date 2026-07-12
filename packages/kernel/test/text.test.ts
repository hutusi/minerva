import { describe, expect, test } from "bun:test";
import { truncateCodePointSafe } from "../src/text";

describe("truncateCodePointSafe", () => {
  test("returns short text unchanged", () => {
    expect(truncateCodePointSafe("hello", 10)).toBe("hello");
  });

  test("cuts at the limit for plain text", () => {
    expect(truncateCodePointSafe("abcdef", 3)).toBe("abc");
  });

  test("never splits a surrogate pair at the boundary", () => {
    // "😀" is a surrogate pair (2 UTF-16 units); a cut at an odd offset
    // inside a run of them must back off one unit, not emit a lone surrogate.
    const text = "😀".repeat(4);
    const cut = truncateCodePointSafe(text, 5);
    expect(cut).toBe("😀😀");
    expect(cut.length).toBe(4);
    // Round-trips through UTF-8 without replacement characters.
    expect(Buffer.from(cut, "utf8").toString("utf8")).toBe(cut);
  });
});
