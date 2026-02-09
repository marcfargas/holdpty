---
name: holdpty
description: "Detached PTY sessions — launch commands in a real pseudo-terminal, attach/view/record later. Use when: launching agents or processes that need a real TTY but should run detached, supervising running agents, recording terminal sessions, viewing agent output. Triggers: detached terminal, background agent, attach to session, view terminal, record session, holdpty."
---

# holdpty — Detached PTY Sessions

Launch commands in a real pseudo-terminal. Attach, view, or dump output later.
Cross-platform: Windows (ConPTY) + Linux + macOS.

## Project Location

```
C:\dev\holdpty
```

## Install

```bash
npm install -g holdpty
```

## Core Commands

### Launch a session

`--fg` or `--bg` is **required** (no default).

```bash
# Detached (returns immediately, prints session name to stdout)
holdpty launch --bg --name worker1 -- pi -p "analyze codebase"

# Foreground (blocks until child exits, returns child exit code)
holdpty launch --fg --name build -- make all

# Auto-generated name
SESSION=$(holdpty launch --bg -- node server.js)
```

### List sessions

```bash
holdpty ls          # human-readable
holdpty ls --json   # machine-readable
```

Stale sessions (crashed holders) are auto-detected and cleaned.

### Attach (interactive, single-writer)

```bash
holdpty attach worker1
# Detach: Ctrl+] then d
# Session keeps running after detach
```

Only one attachment at a time. Error if already attached.

### View (read-only, multiple viewers)

```bash
holdpty view worker1
```

Outputs real PTY data (escape sequences, TUI, colors) to stdout. Multiple viewers allowed simultaneously. Suitable for:
- Supervision (watching an agent work)
- VHS recording (`Type "holdpty view worker1"` in a tape)
- Piping: `holdpty view worker1 | tee session.log`

### Logs (dump buffer, exit)

```bash
holdpty logs worker1
```

Dumps the ring buffer (recent output history) to stdout and exits immediately. No live tailing. Use for:
- Checking agent status from a script
- `holdpty logs worker1 | grep ERROR`
- Any non-interactive output inspection

### Stop a session

```bash
holdpty stop worker1
```

Sends SIGTERM to the child process.

## Stdout Discipline

This matters for scripting and agent use:

| Command | stdout | stderr |
|---------|--------|--------|
| `launch --bg` | Session name only | Status messages |
| `view` | PTY data only | Status messages |
| `logs` | PTY data only | Status messages |
| `ls` | Session list | Nothing |
| `attach` | Terminal takeover | N/A |

## Exit Codes

| Command | Exit code |
|---------|-----------|
| `launch --bg` | 0 on success |
| `launch --fg` | Child's exit code |
| `attach` | Child's exit code (if child exits) or 0 (on detach) |
| `logs` | 0 |
| `view` | 0 |
| `stop` | 0 |

## Environment Variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `HOLDPTY_DIR` | Session socket/metadata directory | `%TEMP%\dt\` (Win) / `$XDG_RUNTIME_DIR/dt/` (Linux) |
| `HOLDPTY_DETACH` | Custom detach key sequence (hex) | `0x1d,0x64` (Ctrl+] then d) |

## Common Agent Patterns

### Launch an agent and check on it later

```bash
SESSION=$(holdpty launch --bg --name analysis -- pi -p "deep analysis of /c/dev/project")
# ... later ...
holdpty logs "$SESSION" | tail -20
```

### Supervise a running agent

```bash
holdpty view worker1
# Watch in real-time, read-only, Ctrl+C to stop viewing
```

### Launch with pm2 for persistence

```bash
# pm2 manages the holder process lifecycle
pm2 start "holdpty launch --fg --name myagent -- pi --mode json" --name holdpty-myagent
# Attach any time:
holdpty attach myagent
```

### Check if a session is alive

```bash
holdpty ls --json | jq '.[] | select(.name == "worker1")'
```

## What holdpty is NOT

- Not a process manager → use pm2 / systemd / nohup for lifecycle
- Not a terminal emulator → your terminal renders the output
- Not tmux/screen → no splits, tabs, config files, status bars
