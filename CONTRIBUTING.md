# Contributing to holdpty

## Setup

```bash
git clone https://github.com/marcfargas/holdpty.git
cd holdpty
npm install
npm run build
```

### Prerequisites

- Node.js >= 18
- node-pty build tools (only if prebuilds don't match your platform):
  - **Windows**: Visual Studio Build Tools (C++ workload)
  - **Linux**: `build-essential`, `python3`
  - **macOS**: Xcode Command Line Tools

## Project Structure

```
holdpty/
├── src/
│   ├── cli.ts              # CLI entry point, command parsing
│   ├── holder.ts           # Holder process (PTY + socket + buffer)
│   ├── client.ts           # Client connections (attach/view/logs)
│   ├── protocol.ts         # Wire protocol framing (encode/decode)
│   ├── ring-buffer.ts      # Circular byte buffer
│   ├── session.ts          # Session directory, metadata, stale detection
│   └── platform.ts         # Platform-specific paths and utilities
├── docs/
│   ├── DESIGN.md           # Architecture and design decisions
│   └── PROTOCOL.md         # Wire protocol specification
├── skills/
│   └── holdpty/
│       └── SKILL.md        # Agent skill file
├── AGENTS.md               # AI agent configuration
├── README.md               # User documentation
└── CONTRIBUTING.md          # This file
```

## Build & Test

```bash
npm run build       # Compile TypeScript
npm run dev         # Watch mode
npm test            # Run tests (vitest)
npm run lint        # Type-check without emitting
```

## Testing

Cross-platform correctness is critical. Key test areas:

1. **Protocol** (`protocol.ts`): frame encoding/decoding, partial reads, boundary cases
2. **Ring buffer** (`ring-buffer.ts`): write, read, overflow, empty state
3. **Session management** (`session.ts`): metadata CRUD, stale detection, cleanup
4. **Integration**: holder ↔ client communication over real sockets

Run tests on both Windows and Linux before submitting.

## Architecture

Read `docs/DESIGN.md` before making changes. Key principles:

- One holder process per session (no central daemon)
- Raw byte relay (no terminal state machine)
- Binary length-prefixed protocol (see `docs/PROTOCOL.md`)
- Filesystem as registry (socket + JSON per session)
- Stdout discipline: `view`/`logs` output PTY data only on stdout

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`
