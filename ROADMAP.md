# holdpty — Roadmap

## Phase 1: MVP

Core functionality — launch, attach, view, and manage detached PTY sessions.

- [ ] `launch` command (--fg, --bg, --name, auto-name)
- [ ] Holder process (PTY via node-pty, ring buffer, Unix domain socket)
- [ ] Binary wire protocol (8 message types, length-prefixed frames)
- [ ] `attach` command (single-writer, buffer replay, detach keybinding)
- [ ] `view` command (read-only, multiple simultaneous viewers)
- [ ] `logs` command (dump buffer to stdout, exit)
- [ ] `ls` command (list sessions, stale detection + auto-cleanup, --json)
- [ ] `stop` command (SIGTERM to child)
- [ ] Ring buffer (1MB, raw terminal bytes)
- [ ] Cross-platform: Windows 10+ (ConPTY) + Linux (forkpty)
- [ ] Prebuilt node-pty binaries for common platforms
- [ ] Test suite (protocol, buffer, session management, integration)

## Phase 2: Polish

Extended functionality for automation and scripting.

- [ ] `info` command (detailed session metadata as JSON)
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
