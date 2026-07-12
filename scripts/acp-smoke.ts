/**
 * Live end-to-end smoke over the real ACP stdio host: AGENTS.md instructions,
 * minerva/skills/list, and /skill expansion, against the configured provider
 * (needs a working API key in ~/.minerva/settings.json — costs two tiny
 * prompts). Run: bun scripts/acp-smoke.ts
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: { update?: { sessionUpdate?: string; content?: { text?: string } } };
  result?: unknown;
  error?: unknown;
}

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

const proj = mkdtempSync(join(tmpdir(), "minerva-smoke-"));
writeFileSync(
  join(proj, "AGENTS.md"),
  'If the user message is exactly "ping", reply with exactly "AGENTS-OK" and nothing else.\n',
);
mkdirSync(join(proj, ".minerva", "skills", "canary"), { recursive: true });
writeFileSync(
  join(proj, ".minerva", "skills", "canary", "SKILL.md"),
  '---\ndescription: Test canary skill\n---\n\nReply with exactly "SKILL-OK <args>" where <args> is the argument text the user passed. Nothing else.\n',
);

const child = spawn("bun", [join("packages", "cli", "src", "index.tsx"), "acp"], {
  cwd: REPO,
  stdio: ["pipe", "pipe", "inherit"],
});
if (!child.stdout || !child.stdin) throw new Error("failed to open child stdio");
const stdin = child.stdin;

let nextId = 1;
const pending = new Map<number, (msg: RpcMessage) => void>();
const chunks: string[] = [];
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  let msg: RpcMessage;
  try {
    msg = JSON.parse(line) as RpcMessage;
  } catch {
    return;
  }
  if (msg.id !== undefined && pending.has(msg.id)) {
    pending.get(msg.id)?.(msg);
    pending.delete(msg.id);
  } else if (msg.method === "session/update") {
    const update = msg.params?.update;
    if (update?.sessionUpdate === "agent_message_chunk" && update.content?.text) {
      chunks.push(update.content.text);
    }
  }
});

function request<T>(method: string, params: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (msg) =>
      msg.error
        ? reject(new Error(`${method}: ${JSON.stringify(msg.error)}`))
        : resolve(msg.result as T),
    );
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

const results: string[] = [];
const check = (label: string, ok: boolean, detail: string) => {
  results.push(`${ok ? "PASS" : "FAIL"}  ${label}  ${detail}`);
};

try {
  const init = await request<{ protocolVersion: number }>("initialize", { protocolVersion: 1 });
  check("initialize", init.protocolVersion === 1, JSON.stringify(init));

  const skills = await request<{ skills: Array<{ name: string }> }>("minerva/skills/list", {
    cwd: proj,
  });
  check(
    "skills/list",
    skills.skills.length === 1 && skills.skills[0]?.name === "canary",
    JSON.stringify(skills),
  );

  const sn = await request<{
    sessionId: string;
    instructions?: { files: Array<{ scope: string }> };
  }>("session/new", { cwd: proj });
  check(
    "session/new instructions",
    sn.instructions?.files.length === 1 && sn.instructions.files[0]?.scope === "project",
    JSON.stringify(sn.instructions),
  );

  chunks.length = 0;
  const p1 = await request<{ stopReason: string }>("session/prompt", {
    sessionId: sn.sessionId,
    prompt: [{ type: "text", text: "ping" }],
  });
  const reply1 = chunks.join("");
  check(
    "AGENTS.md canary",
    p1.stopReason === "end_turn" && reply1.includes("AGENTS-OK"),
    `stop=${p1.stopReason} reply=${JSON.stringify(reply1.slice(0, 120))}`,
  );

  chunks.length = 0;
  const p2 = await request<{ stopReason: string }>("session/prompt", {
    sessionId: sn.sessionId,
    prompt: [{ type: "text", text: "/canary zebra42" }],
  });
  const reply2 = chunks.join("");
  check(
    "skill /canary expansion",
    p2.stopReason === "end_turn" && reply2.includes("SKILL-OK") && reply2.includes("zebra42"),
    `stop=${p2.stopReason} reply=${JSON.stringify(reply2.slice(0, 120))}`,
  );
} catch (error) {
  results.push(`ERROR ${error instanceof Error ? error.message : String(error)}`);
} finally {
  stdin.end();
  setTimeout(() => child.kill("SIGKILL"), 3000).unref();
}

console.log(results.join("\n"));
process.exit(results.some((entry) => !entry.startsWith("PASS")) ? 1 : 0);
