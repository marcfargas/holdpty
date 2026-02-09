---
"holdpty": minor
---

Initial release.

- **Launch**: Start commands in a detached PTY with `launch --bg`/`--fg`. Auto-generates session names, supports `--name` override. `--` separator is optional (PowerShell compatible).
- **Attach**: Interactive single-writer connection with `attach`. Detach with Ctrl+A then d (screen convention). Ctrl+A Ctrl+A sends literal Ctrl+A. Customizable via `HOLDPTY_DETACH` env var.
- **View**: Read-only live stream with `view`. Multiple simultaneous viewers. Outputs real PTY data (escape sequences, TUI, colors).
- **Logs**: Dump ring buffer with `logs`. Supports `--tail N` (last N lines), `--follow`/`-f` (live streaming), `--no-replay` (skip history).
- **Session management**: `ls` (with `--json`), `stop`, `info`. Stale session auto-cleanup.
- **Cross-platform**: Windows (ConPTY + named pipes) and Linux/macOS (forkpty + UDS). Automatic `.exe` resolution on Windows PATH.
- **Binary protocol**: Length-prefixed frames over Unix domain sockets / named pipes. 1MB ring buffer for output replay.
- **pi-package**: Installable as a pi skill via `pi install npm:holdpty`.
