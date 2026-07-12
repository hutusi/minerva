import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";
import { type ReactNode, useMemo } from "react";

/**
 * Terminal markdown: marked's lexer feeds a hand-rolled Ink renderer, so the
 * only dependency is the parser. Streaming re-lexes the whole partial text
 * every frame — sub-millisecond at transcript sizes — and any token family
 * the renderer doesn't know falls back to its raw source, never dropping
 * content.
 */

/** Past this size re-lexing per frame stops being cheap — plain text instead. */
const LEX_LIMIT = 50_000;

export function Markdown({ text }: { text: string }) {
  const tokens = useMemo(() => (text.length > LEX_LIMIT ? null : marked.lexer(text)), [text]);
  if (!tokens) return <Text>{text}</Text>;
  return <Box flexDirection="column">{renderTokens(tokens)}</Box>;
}

/**
 * Pure token → Ink mapping. Keys are source offsets, not array indices: a
 * streaming re-lex keeps the settled prefix's keys stable, so React only
 * re-renders the tail that actually changed.
 */
function renderTokens(tokens: Token[]): ReactNode {
  let offset = 0;
  return tokens.map((token) => {
    const key = `${offset}:${token.type}`;
    offset += token.raw.length;
    return <BlockToken key={key} token={token} />;
  });
}

function BlockToken({ token }: { token: Token }) {
  switch (token.type) {
    case "heading":
      return (
        <Text bold {...(token.depth <= 2 ? { color: "cyan" } : {})}>
          {renderInline(token.tokens)}
        </Text>
      );
    case "paragraph":
      return <Text>{renderInline(token.tokens)}</Text>;
    // Block-level text (list items, lazy continuation lines).
    case "text":
      return (
        <Text>{"tokens" in token && token.tokens ? renderInline(token.tokens) : token.raw}</Text>
      );
    case "code":
      return <CodeBlock token={token as Tokens.Code} />;
    case "list":
      return <ListBlock token={token as Tokens.List} />;
    case "blockquote":
      return (
        <Box>
          <Text dimColor>▎ </Text>
          <Box flexDirection="column">{renderTokens(token.tokens ?? [])}</Box>
        </Box>
      );
    case "hr":
      return <Text dimColor>{"─".repeat(40)}</Text>;
    case "space":
      return <Text> </Text>;
    // table / html / anything future — raw source beats dropped content.
    default:
      return <Text>{token.raw}</Text>;
  }
}

function CodeBlock({ token }: { token: Tokens.Code }) {
  let offset = 0;
  return (
    <Box flexDirection="column" marginLeft={2}>
      {token.lang ? <Text dimColor>{token.lang}</Text> : null}
      {token.text.split("\n").map((line) => {
        const key = `code-${offset}`;
        offset += line.length + 1;
        return (
          <Text key={key} color="cyan" dimColor>
            {line || " "}
          </Text>
        );
      })}
    </Box>
  );
}

function ListBlock({ token }: { token: Tokens.List }) {
  const start = typeof token.start === "number" ? token.start : 1;
  let offset = 0;
  return (
    <Box flexDirection="column">
      {token.items.map((item, ordinal) => {
        const key = `item-${offset}`;
        offset += item.raw.length;
        return (
          <Box key={key} marginBottom={token.loose && ordinal < token.items.length - 1 ? 1 : 0}>
            <Text>{token.ordered ? `${start + ordinal}. ` : "• "}</Text>
            <Box flexDirection="column">{renderTokens(item.tokens ?? [])}</Box>
          </Box>
        );
      })}
    </Box>
  );
}

function renderInline(tokens: Token[] | undefined): ReactNode {
  if (!tokens) return null;
  let offset = 0;
  return tokens.map((token) => {
    const key = `${offset}:${token.type}`;
    offset += token.raw.length;
    return <InlineToken key={key} token={token} />;
  });
}

function InlineToken({ token }: { token: Token }) {
  switch (token.type) {
    case "strong":
      return <Text bold>{renderInline(token.tokens)}</Text>;
    case "em":
      return <Text italic>{renderInline(token.tokens)}</Text>;
    case "del":
      return <Text strikethrough>{renderInline(token.tokens)}</Text>;
    case "codespan":
      return <Text color="cyan">{token.text}</Text>;
    case "link": {
      const label = (
        <Text color="blue" underline>
          {renderInline(token.tokens)}
        </Text>
      );
      if (token.href === token.text) return label;
      return (
        <Text>
          {label}
          <Text dimColor> ({token.href})</Text>
        </Text>
      );
    }
    case "escape":
      return <Text>{token.text}</Text>;
    case "br":
      return <Text>{"\n"}</Text>;
    case "text":
      return <Text>{token.raw}</Text>;
    default:
      return <Text>{token.raw}</Text>;
  }
}
