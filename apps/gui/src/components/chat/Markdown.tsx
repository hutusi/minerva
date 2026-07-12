import DOMPurify from "dompurify";
import { marked } from "marked";
import { useMemo } from "react";

/**
 * Markdown is for model output only (same rule as the TUI): info/user/tool
 * text stays plain so command echoes are never reinterpreted. The model's
 * HTML goes through DOMPurify — assistant output is untrusted input.
 */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text],
  );
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
    <div className="markdown text-sm leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
