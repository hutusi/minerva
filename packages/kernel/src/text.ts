/**
 * Truncate to at most `maxUnits` UTF-16 units without splitting a surrogate
 * pair: a lone surrogate at the cut is invalid Unicode and can break JSON
 * encoding when the text is sent to a model provider. Caps throughout the
 * kernel are documented in "characters" (UTF-16 units), so this keeps their
 * arithmetic while making the cut safe.
 */
export function truncateCodePointSafe(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  let end = maxUnits;
  const last = text.charCodeAt(end - 1);
  // High surrogate at the boundary means the next unit completes it.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
}
