# Minerva

A cross-platform, model-agnostic code agent — a headless kernel with multiple
frontends (CLI now, GUI later).

- **Architecture**: protocol everywhere ([ACP](https://agentclientprotocol.com)
  core + `minerva/*` extensions), one kernel, swappable transports.
- **Stack**: TypeScript, Bun, Vercel AI SDK, Ink (CLI), Tauri 2 (GUI, planned).

See [docs/DESIGN.md](docs/DESIGN.md) for the design record.

## Development

```sh
bun install
bun run verify   # typecheck + lint + tests
bun run --cwd packages/cli dev
```
