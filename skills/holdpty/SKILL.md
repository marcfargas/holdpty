---
name: holdpty
description: "Detached PTY sessions — launch commands in a real pseudo-terminal, attach/view/record later. Use when: launching agents or processes that need a real TTY but should run detached, supervising running agents, recording terminal sessions, viewing agent output. Triggers: detached terminal, background agent, attach to session, view terminal, record session, holdpty."
---

# holdpty — Detached PTY Sessions

Launch commands in a real pseudo-terminal. Attach, view, or dump output later.
Cross-platform: Windows (ConPTY, named pipes) + Linux (forkpty, UDS) + macOS.

## Project Location

```
C:\dev\holdpty
```

## Install & Build

```bash
cd C:\dev\holdpty
npm install
npm run build
# CLI: node dist/cli.js (or 'holdpty' after npm install -g)
```

## Core Commands

### Launch a session

`--fg` or `--bg` is **required** (no default).

```bash
# Detached (returns immediately, prints session name to stdout)
holdpty launch --bg --name worker1 -- pi -p "analyze codebase"

# Foreground (blocks until child exits, returns child exit code)
holdpty launch --fg --name build -- make all

# Auto-generated name (format: basename-xxxx)
SESSION=$(holdpty launch --bg -- node server.js)
```

**Windows note**: Use `node.exe` not `node` when launching Node.js commands directly (node-pty doesn't search PATH the same way).

**Windows `.cmd` wrappers do NOT work.** npm-installed CLIs on Windows use `.cmd` shims (e.g. `pi.cmd`, `tsc.cmd`). holdpty (via node-pty) cannot execute these — the holder will fail to start. Always resolve to the actual `.js` entry point:

```bash
# ❌ WRONG — pi resolves to pi.cmd, holder fails
holdpty launch --bg --name agent -- pi -p "prompt"

# ✅ CORRECT — use node.exe with the actual cli.js
holdpty launch --bg --name agent -- node.exe "C:\path\to\cli.js" -p "prompt"

# Find the real path behind a .cmd shim:
cat "$(which pi)" | head -5   # look for the .js path
```

### List sessions

```bash
holdpty ls          # human-readable table
holdpty ls --json   # machine-readable JSON array
```

Stale sessions (crashed holders) are auto-detected and cleaned on every `ls`.

### Attach (interactive, single-writer)

```bash
holdpty attach worker1
# Detach: Ctrl+] then d
# Session keeps running after detach
```

Only one attachment at a time. Error if already attached. Requires a real TTY.

### View (read-only, multiple viewers)

```bash
holdpty view worker1
```

Outputs real PTY data (escape sequences, TUI, colors) to stdout. Includes both buffer replay (history) and live stream. Multiple viewers allowed simultaneously.

### Logs (dump buffer, exit)

```bash
holdpty logs worker1
```

Dumps the 1MB ring buffer (recent output history) to stdout and exits immediately. No live tailing.

### Stop a session

```bash
holdpty stop worker1
```

Kills both the child process and the holder process.

### Info

```bash
holdpty info worker1    # JSON with name, pid, childPid, command, cols, rows, startedAt, active
```

## Stdout Discipline

This matters for scripting and agent use:

| Command | stdout | stderr |
|---------|--------|--------|
| `launch --bg` | Session name only | Nothing |
| `launch --fg` | Session name | Nothing |
| `view` | PTY data only | Status messages |
| `logs` | PTY data only | Status messages |
| `ls` | Session list | "No active sessions" if empty |
| `ls --json` | JSON array | Nothing |
| `info` | JSON object | Errors only |
| `attach` | Terminal takeover | N/A |
| `stop` | Nothing | Confirmation |

## Exit Codes

| Command | Exit code |
|---------|-----------|
| `launch --bg` | 0 on success |
| `launch --fg` | Child's exit code |
| `attach` | Child's exit code (if child exits) or 0 (on detach) |
| `logs` | 0 |
| `view` | 0 |
| `stop` | 0 |
| Any error | 1 |

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `HOLDPTY_DIR` | Session metadata directory | `%TEMP%\dt\` (Win) / `$XDG_RUNTIME_DIR/dt/` (Linux) |
| `HOLDPTY_DETACH` | Custom detach sequence (hex) | `0x1d,0x64` (Ctrl+] then d) |
| `HOLDPTY_LINGER_MS` | Shutdown linger time in ms | `5000` |

## Platform Details

| | Windows | Linux/macOS |
|---|---------|-------------|
| PTY backend | ConPTY | forkpty |
| IPC transport | Named pipes (`//./pipe/holdpty-<hash>-<name>`) | Unix domain sockets (`{dir}/{name}.sock`) |
| Signal behavior | `SIGTERM` = instant `TerminateProcess` | `SIGTERM` = graceful |
| Metadata | `%TEMP%\dt\{name}.json` | `$XDG_RUNTIME_DIR/dt/{name}.json` |

Named pipes include a hash of `HOLDPTY_DIR` to isolate different environments.

## Common Agent Patterns

### Launch an agent and check on it later

```bash
SESSION=$(holdpty launch --bg --name analysis -- node.exe agent.js)
# ... later ...
holdpty logs "$SESSION" | tail -20
```

### Supervise a running agent

```bash
holdpty view worker1
# Watch in real-time, read-only, Ctrl+C to stop viewing
```

### Check if a session is alive

```bash
holdpty info worker1  # JSON with "active": true/false
holdpty ls --json     # all sessions as array
```

### Scripting pattern

```bash
NAME=$(holdpty launch --bg --name myagent -- node.exe server.js)
echo "Launched: $NAME"
sleep 2
holdpty logs "$NAME" | grep "listening"
holdpty stop "$NAME"
```

## Architecture (for developers)

- One holder process per session (no central daemon)
- Binary length-prefixed protocol: `[1B type][4B len BE][payload]` (8 message types)
- 1MB ring buffer for output replay
- Filesystem is the registry (`.json` metadata files)
- Raw byte relay (no terminal state machine / ANSI parsing)

Source: `src/` — `cli.ts`, `holder.ts`, `client.ts`, `protocol.ts`, `ring-buffer.ts`, `session.ts`, `platform.ts`

## What holdpty is NOT

- Not a process manager → use pm2 / systemd / nohup for lifecycle
- Not a terminal emulator → your terminal renders the output
- Not tmux/screen → no splits, tabs, config files, status bars
