# holdpty — Design Document

## Problem

When launching AI agents (or any long-running interactive process) programmatically, you lose the terminal. Process managers (pm2, systemd) capture logs but don't provide a real PTY — programs detect non-interactive mode and behave differently (no TUI, no color, different output).

On Linux, `screen`/`tmux` solve this but do far too much. `dtach` and `abduco` are minimal alternatives but are Unix-only and written in C. On Windows, nothing equivalent exists.

holdpty fills this gap: a minimal, cross-platform tool that holds a PTY open and lets you attach/view later. Built for the Node.js ecosystem with first-class Windows support via ConPTY.

## Architecture

### Session Model

A **session** consists of:
- A holder process (long-running, owns the PTY)
- A pseudo-terminal (via node-pty: ConPTY on Windows, forkpty on Linux/macOS)
- A ring buffer (1MB, raw terminal bytes)
- A Unix domain socket accepting client connections
- A metadata file (JSON) with session info

```
┌─────────────────────────────────────────────┐
│  Holder Process                              │
│                                              │
│  ┌─────────┐     ┌──────────────┐           │
│  │ node-pty │◄───►│ Ring Buffer  │           │
│  │  (PTY)   │     │ (1MB raw)    │           │
│  └─────────┘     └──────┬───────┘           │
│       ▲                  │                   │
│       │                  ▼                   │
│       │          ┌──────────────┐           │
│       └──────────│ Unix Socket  │           │
│                  │  (.sock)     │           │
│                  └──────┬───────┘           │
│                         │                   │
└─────────────────────────┼───────────────────┘
                          │
              ┌───────────┼───────────┐
              │           │           │
         ┌────▼───┐  ┌───▼───┐  ┌───▼───┐
         │ attach │  │ view  │  │ view  │
         │ (r/w)  │  │ (r/o) │  │ (r/o) │
         └────────┘  └───────┘  └───────┘
```

### Filesystem Registry

No central daemon. The session directory IS the registry:

```
$HOLDPTY_DIR/
  ├── worker1.sock      # Unix domain socket
  ├── worker1.json      # Metadata
  ├── pi-a3f2.sock
  └── pi-a3f2.json
```

Metadata file (`{name}.json`):
```json
{
  "name": "worker1",
  "pid": 12345,
  "childPid": 12346,
  "command": ["node", "server.js"],
  "cols": 120,
  "rows": 40,
  "startedAt": "2026-02-09T11:00:00Z"
}
```

### Session Directory Paths

Short paths to stay under Windows 108-char UDS limit:

| Platform | Default | Override |
|----------|---------|----------|
| Windows | `%TEMP%\dt\` | `HOLDPTY_DIR` |
| Linux | `$XDG_RUNTIME_DIR/dt/` or `/tmp/dt-$UID/` | `HOLDPTY_DIR` |

### Connection Model

- **attach**: Single-writer. Bidirectional (stdin forwarded to PTY, PTY output to client). Resize events propagated. Only one attach at a time — subsequent attempts get a clear error.
- **view**: Read-only. Multiple simultaneous viewers. Receives buffer replay + live stream. Does not affect the PTY (no resize, no input). Sees real terminal output including escape sequences.
- **logs**: Connect, receive buffer replay, disconnect after REPLAY_END. No live tailing.

### Ring Buffer

- Fixed 1MB circular buffer of raw terminal bytes (including escape sequences).
- On client connect: replay buffer contents before switching to live stream.
- No terminal state machine. The client's terminal emulator interprets the escape sequences.
- Trade-off: if the buffer is too small to reconstruct full screen state, the viewer sees partial rendering. 1MB is generous enough for most use cases.

### Holder Lifecycle

1. Create PTY via node-pty, spawn child command
2. Create session directory if needed
3. Write metadata JSON
4. Create Unix domain socket, start listening
5. Read PTY output → write to ring buffer + broadcast to connected clients
6. Accept client connections, manage attach/view multiplexing
7. On child exit: drain remaining PTY output (100ms delay for ConPTY flush), send EXIT message to all clients, linger 5s for final connections, clean up socket + metadata, exit

### Foreground vs Background

`holdpty launch` requires `--fg` or `--bg` explicitly:

- **`--fg`**: The holder process IS the foreground process. Blocks until child exits. Returns child's exit code.
- **`--bg`**: Spawns the holder as a detached child process (`child_process.spawn({detached: true, stdio: 'ignore'})` + `unref()`). Prints session name to stdout and returns immediately.

The tool never daemonizes itself. `--bg` is a convenience for Windows (where `&` doesn't work in cmd.exe). On Linux, callers can use `--fg &` or nohup or pm2 as they prefer.

### Detach Keybinding

Default: `Ctrl+A` then `d` (bytes `0x01, 0x64`) — same as GNU screen.

Works on all keyboard layouts, including those where `]` or `\` require a modifier (e.g., Spanish, German).

The attach client runs in raw mode. All bytes are forwarded to the PTY EXCEPT the detach sequence. When `0x01` is received, the client waits briefly for the next byte:
- If `d` → detach (close connection cleanly, holder keeps running)
- If anything else → forward both bytes to the PTY
- If timeout (200ms) → forward `0x01` to the PTY

Configurable via `HOLDPTY_DETACH` env var (format: comma-separated hex bytes, e.g., `0x01,0x64` for Ctrl+A then d).

### Stale Session Detection

On `ls` and on `launch --name`:
1. Read session directory
2. For each `.json` file, check if holder PID is alive (fast, no I/O)
3. If PID is dead: attempt socket connect with 100ms timeout
4. If socket connect fails: remove `.sock` + `.json`, report as cleaned

This runs automatically. No manual `clean` command needed (though one could be added later).

### Exit Code Contract

| Command | Returns |
|---------|---------|
| `launch --bg` | 0 on successful launch |
| `launch --fg` | Child's exit code |
| `attach` | Child's exit code if child exits while attached; 0 on user detach |
| `view` | 0 |
| `logs` | 0 |
| `stop` | 0 if signal sent successfully |
| `ls` | 0 |

### Stdout Discipline

- `launch --bg`: prints session name to stdout (enables `SESSION=$(holdpty launch --bg -- cmd)`)
- `view` and `logs`: PTY data ONLY on stdout. All status/error messages to stderr.
- `ls`: session list to stdout (text or JSON with `--json`)
- `attach`: takes over terminal entirely (raw mode)
- `stop`: confirmation to stderr only

## Wire Protocol

See [PROTOCOL.md](PROTOCOL.md) for the full specification.

Summary: binary length-prefixed frames. `[1B type][4B length BE uint32][payload]`. 8 message types. Zero overhead for data frames, trivial to implement.

## Design Decisions

### Why Node.js + node-pty
- node-pty is the only cross-platform PTY library supporting ConPTY (Windows) + forkpty (Linux/macOS)
- Battle-tested in VS Code (millions of installs)
- npm distribution matches the target audience (Node.js/AI agent ecosystem)
- Architecture is runtime-agnostic — could port to Rust + portable-pty later if needed

### Why not a terminal state machine
Adding a VT parser to reconstruct screen state would:
- Add thousands of lines of code (xterm.js is 50K+ lines)
- Introduce rendering bugs for edge-case programs
- Provide marginal benefit (raw replay works for 99% of use cases)

### Why not JSON protocol
Terminal output contains arbitrary bytes (including NUL, newlines, partial UTF-8). JSON encoding requires base64 or escaping, doubling bandwidth and adding latency. Binary framing is zero-overhead.

### Why not central daemon
One holder per session means: no single point of failure, no coordination overhead, no IPC between sessions, trivial to reason about. The filesystem is the only shared state.

### Why --fg/--bg is required
Agents must be explicit about what they want. A default (either way) leads to confusion:
- Default --bg: users who expect foreground are surprised
- Default --fg: agents who expect fire-and-forget block unexpectedly
Forcing the choice costs one flag and eliminates an entire class of bugs.

## Known Platform Quirks

### Windows (ConPTY)
- Output arrives in batches, not byte-by-byte. Clients may perceive slight lag.
- Final output may not flush before EOF. Holder waits 100-200ms after child exit to drain.
- ConPTY translates Win32 console API calls to VT sequences. Translation is imperfect for some legacy apps.
- Resize can cause output corruption if mid-escape-sequence. Debounce resize events (50ms).
- Socket files are locked while in use. Close connections before unlinking.
- UDS paths limited to ~108 chars. Use short session directory paths.

### Linux
- `$XDG_RUNTIME_DIR` is typically `/run/user/$UID`, already user-private (mode 0700).
- `/tmp` fallback: create directory with mode 0700.

## Phases

### Phase 1 (MVP)
- `launch` (--fg, --bg, --name)
- `attach` (single-writer, detach keybinding)
- `view` (read-only, multiple simultaneous)
- `logs` (dump buffer, exit)
- `ls` (with stale detection + auto-cleanup, --json)
- `stop` (SIGTERM)
- Binary protocol (8 message types)
- Ring buffer (1MB)
- Cross-platform: Windows + Linux
- Prebuilt node-pty binaries

### Phase 2
- `info` command (detailed metadata)
- `send` command (inject input without attaching)
- `wait` command (block until exit, return code)
- Resize propagation on attach
- `--size COLSxROWS` override
- `--signal` for stop
- `--timeout` for launch

### Explicitly Out of Scope
- Window management (splits, tabs, panes)
- Configuration files
- Daemonization (use pm2/systemd/nohup)
- Session groups or persistence
- Terminal state machine / ANSI parsing
- Non-interactive mode (if you don't want a PTY, don't use holdpty)
