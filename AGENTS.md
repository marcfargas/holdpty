# holdpty — Agent Configuration

## Project Overview

Minimal cross-platform detached PTY tool. Spiritual successor to dtach/abduco for Node.js + Windows.

- **Stack**: TypeScript, Node.js, node-pty
- **Package manager**: npm
- **Testing**: Vitest
- **Build**: `tsc` (ESM, Node16 module resolution)
- **License**: MIT

## Design Documents

Read these before making architectural changes:

- `docs/DESIGN.md` — full architecture, protocol spec, and design decisions
- `docs/PROTOCOL.md` — wire protocol reference
- `README.md` — user-facing documentation

## Code Conventions

- TypeScript strict mode, no `any`
- ESM (`"type": "module"`)
- File naming: `kebab-case.ts`
- Types: `PascalCase`, functions: `camelCase`, constants: `UPPER_SNAKE`
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`

## Key Architecture Rules

1. **One holder process per session** — no central daemon, no shared state
2. **Raw byte relay** — no terminal state machine, no ANSI parsing. Store what the PTY emits, replay verbatim.
3. **Binary length-prefixed protocol** — `[1B type][4B length BE][payload]`. No JSON-lines, no escape framing.
4. **Filesystem is the registry** — session directory has `.sock` + `.json` per session. No database.
5. **Not a process manager** — lifecycle is the caller's problem (pm2, nohup, shell)
6. **Stdout discipline** — `view` and `logs` output PTY data ONLY on stdout. Status/errors to stderr always.

## Testing

Cross-platform tests are critical. Test on Windows + Linux. Key areas:
- Socket lifecycle (create, connect, stale detection, cleanup)
- Ring buffer (write, replay, overflow)
- Protocol framing (encode/decode, partial reads)
- PTY spawn + data relay (node-pty integration)

## Common Pitfalls

- **Windows UDS path length**: max ~108 chars. Session dir uses short paths (`%TEMP%\dt\`).
- **node-pty onExit fires before last onData**: drain with small delay after child exit.
- **node-pty resize throws if process exited**: wrap in try/catch.
- **ConPTY ghost processes**: track child PID explicitly for cleanup.
- **Socket file locked on Windows**: close all connections before unlinking.
