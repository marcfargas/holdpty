# holdpty

Minimal cross-platform detached PTY — a pseudo-terminal that makes programs think they're running in a real terminal. Launch commands, attach/view/record later.

> **Status**: Beta — fully functional on Windows and Linux. CLI flags may evolve before 1.0.

## Why

When you launch a long-running process (an AI agent, a build, a server) programmatically, you lose the terminal. The process runs headless — no TUI, no colors, no way to see or interact with it.

On Linux, `screen` or `tmux` solve this — but they do far too much. On Windows, nothing equivalent exists.

**holdpty** sits between `nohup` and `screen`:
- More than `nohup`: preserves a real PTY so programs behave interactively (TUI, colors, line editing).
- Less than `screen`/`tmux`: no window management, no splits, no keybindings, no config files.

One thing, done well, composable with other tools.

## Prior Art

holdpty is a spiritual successor to [dtach](https://github.com/crigler/dtach) (Ned T. Crigler) and [abduco](https://github.com/martanne/abduco) (Marc André Tanner) — minimal detach/attach tools for Unix. holdpty brings the same concept to the **Node.js ecosystem with first-class Windows support** via ConPTY.

Also worth noting: [alden](https://ansuz.sooke.bc.ca/entry/389) (mskala, 2025) takes a different approach — it uses named pipes instead of a PTY layer to relay the raw character stream, which preserves the outer terminal's native scrollback. The tradeoff is Linux-only and no output replay buffer.

## Install

```bash
npm install -g holdpty
```

### Prerequisites

- **Node.js 18+** and npm
- holdpty uses [node-pty](https://github.com/microsoft/node-pty) for cross-platform PTY support. On most systems, prebuilt binaries are included. If not:
  - **Windows**: [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload)
  - **Linux**: `build-essential`, `python3`
  - **macOS**: Xcode Command Line Tools

## Quick Start

```bash
# Launch a command in a detached PTY (returns immediately)
holdpty launch --bg --name worker1 -- node server.js

# List running sessions
holdpty ls

# Attach interactively (Ctrl+A then d to detach)
holdpty attach worker1

# Watch from another terminal (read-only, multiple viewers allowed)
holdpty view worker1

# Dump the output buffer and exit (for scripts/agents)
holdpty logs worker1

# Stop a session
holdpty stop worker1
```

## Commands

| Command | Description | Stdout |
|---------|-------------|--------|
| `launch --bg` | Start session detached, return immediately | Session name |
| `launch --fg` | Start session in foreground (blocks until child exits) | Nothing |
| `attach <session>` | Interactive connection (single-writer) | Terminal takeover |
| `view <session>` | Read-only live stream (multiple viewers) | PTY data only |
| `logs <session>` | Dump output buffer to stdout, exit (supports `--tail`, `--follow`, `--no-replay`) | PTY data only |
| `ls [--json]` | List active sessions (auto-cleans stale) | Session list |
| `stop <session>` | Send SIGTERM to child process | Confirmation (stderr) |
| `info <session>` | Show session metadata | JSON |

### Launch

```bash
# --fg or --bg is required (no default — be explicit)
holdpty launch --bg --name myapp -- python train.py
holdpty launch --fg --name build -- make all

# Auto-generated name if --name omitted
holdpty launch --bg -- npm start
# Prints: npm-a3f2
```

The `--` separator before the command is optional. This is important for **PowerShell**, which strips `--` before it reaches the process:

```powershell
# Both work:
holdpty launch --bg --name worker1 -- node server.js
holdpty launch --bg --name worker1 node server.js
```

### Attach & Detach

```bash
holdpty attach worker1
# You're now in the session. Your keystrokes go to the PTY.
# Detach: Ctrl+A then d
# The session keeps running after detach.
```

Only one attachment at a time. If someone is already attached:
```
Error: session "worker1" has an active attachment. Use 'holdpty view worker1' for read-only access.
```

### View (for agents, VHS, supervision)

```bash
# Read-only live stream — see exactly what the PTY is rendering
holdpty view worker1

# Multiple viewers can connect simultaneously
# view outputs real terminal data (escape sequences, TUI, colors)
# Your terminal renders it — like watching over someone's shoulder
```

### Logs (for scripting and agents)

```bash
# Dump the ring buffer contents and exit
holdpty logs worker1

# Last 50 lines only
holdpty logs worker1 --tail 50

# Follow: replay buffer + keep streaming live output (like tail -f)
holdpty logs worker1 --follow
holdpty logs worker1 -f --tail 50

# Live output only, skip buffer replay
holdpty logs worker1 -f --no-replay

# Pipe-friendly
holdpty logs worker1 --tail 20 | grep ERROR
```

## Detach Keybinding

Default: **`Ctrl+A`** then **`d`** (same as GNU screen). Works on all keyboard layouts.

Press Ctrl+A twice to send a literal Ctrl+A to the process.

Configurable via `HOLDPTY_DETACH` — comma-separated hex bytes (Ctrl+A = `0x01`, Ctrl+B = `0x02`, d = `0x64`):
```bash
export HOLDPTY_DETACH="0x02,0x64"  # Ctrl+B then d (tmux-style)
export HOLDPTY_DETACH="0x1d,0x64"  # Ctrl+] then d (telnet-style)
```

## Session Directory

Sessions are stored as Unix domain sockets + JSON metadata:

| Platform | Default path |
|----------|-------------|
| Windows | `%TEMP%\dt\` |
| Linux | `$XDG_RUNTIME_DIR/dt/` or `/tmp/dt-$UID/` |

Override: `HOLDPTY_DIR` environment variable.

## How It Works

Each session is a **holder process** that:
1. Creates a PTY via `node-pty` (ConPTY on Windows, forkpty on Linux/macOS)
2. Spawns the command inside it
3. Buffers output in a 1MB ring buffer
4. Listens on a Unix domain socket for client connections
5. Relays data between clients and the PTY using a binary protocol
6. Exits when the child process exits, cleaning up socket + metadata

Sessions are regular processes — they don't daemonize themselves. Use `--bg` for detached launch, or manage with pm2/systemd/nohup as needed. This is not a process manager.

## Exit Codes

| Command | Exit code |
|---------|-----------|
| `launch --bg` | 0 on successful launch |
| `launch --fg` | Child's exit code |
| `attach` | Child's exit code if child exits while attached; 0 on detach |
| `view` | 0 |
| `logs` | 0 |
| `stop` | 0 if signal sent |

## What holdpty is NOT

- **Not a process manager.** Use pm2, systemd, nohup for lifecycle management.
- **Not a terminal emulator.** Your terminal (Windows Terminal, iTerm, etc.) does the rendering.
- **Not a window manager.** No splits, tabs, panes. One PTY per session.
- **Not a config-driven tool.** Everything via CLI flags and env vars.

## Platform Support

| Platform | PTY backend | Status |
|----------|------------|--------|
| Windows 10+ | ConPTY | ✅ Primary |
| Linux | forkpty | ✅ Supported |
| macOS | forkpty | ✅ Supported |

## Contributing & Support

- **Bugs & feature requests**: [GitHub Issues](https://github.com/marcfargas/holdpty/issues)
- **Source code**: [github.com/marcfargas/holdpty](https://github.com/marcfargas/holdpty)

## License

MIT — see [LICENSE](LICENSE).
