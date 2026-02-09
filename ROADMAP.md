# holdpty — Roadmap

## Phase 1: MVP ✅

Core functionality — launch, attach, view, and manage detached PTY sessions.

- [x] `launch` command (--fg, --bg, --name, auto-name)
- [x] Holder process (PTY via node-pty, ring buffer, named pipes / UDS)
- [x] Binary wire protocol (8 message types, length-prefixed frames)
- [x] `attach` command (single-writer, buffer replay, detach keybinding)
- [x] `view` command (read-only, multiple simultaneous viewers)
- [x] `logs` command (dump buffer to stdout, exit)
- [x] `ls` command (list sessions, stale detection + auto-cleanup, --json)
- [x] `stop` command (SIGTERM to child + holder)
- [x] `info` command (session metadata as JSON)
- [x] Ring buffer (1MB, raw terminal bytes)
- [x] Cross-platform: Windows 10+ (ConPTY) + Linux (forkpty)
- [x] Test suite: 69 tests (unit, integration, E2E)

## Phase 2: Polish

Extended functionality for automation and scripting.

- [ ] `send` command (inject input without attaching)
- [ ] `wait` command (block until session ends, return exit code)
- [ ] Resize propagation on attach (forward terminal resize to PTY)
- [ ] `--size COLSxROWS` override on launch
- [ ] `--signal` option for stop
- [ ] `--timeout` for launch (auto-kill after duration)

## Phase 3: Distribution & Ecosystem

- [ ] Node SEA or pkg standalone binary (no npm install required)
- [ ] Configurable buffer size
- [ ] macOS testing and prebuilds
- [ ] VHS integration examples and documentation
- [ ] pm2 integration guide

## Known Issues

- **node-pty ConPTY noise on Windows**: node-pty's internal `conpty_console_list_agent.js` crashes with `AttachConsole failed` on stderr when the PTY runs in non-interactive contexts (CI, detached processes, test runners). This is a [node-pty bug](https://github.com/microsoft/node-pty/issues) — the agent uses `child_process.fork()` without error handling. Functionally harmless (PTY works fine), but the stderr output is ugly. Upstream fix needed.
