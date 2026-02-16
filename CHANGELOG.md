# holdpty

## 0.2.1

### Patch Changes

- [`be32bd5`](https://github.com/marcfargas/holdpty/commit/be32bd5598ca6c579c5712305123f06dd3466403) Thanks [@marcfargas](https://github.com/marcfargas)! - Fix launching `.cmd`/`.bat` commands on Windows (e.g., `pi`, `npm`). node-pty can't execute script shims directly — they are now wrapped with `cmd.exe /c` automatically while native `.exe` commands are spawned directly.

- [`76cbf56`](https://github.com/marcfargas/holdpty/commit/76cbf56d0d9ee6836903fcb983d66d3816b81f75) Thanks [@marcfargas](https://github.com/marcfargas)! - Fix `launch --fg` not showing interactive terminal. The PTY was running but stdin/stdout were never connected, leaving the user with a blank screen. Foreground mode now bridges I/O directly to the PTY with raw mode and resize support.

- [`be32bd5`](https://github.com/marcfargas/holdpty/commit/be32bd5598ca6c579c5712305123f06dd3466403) Thanks [@marcfargas](https://github.com/marcfargas)! - Fix Unicode corruption in PTY output. Characters like `π`, `↑↓←→`, box-drawing lines, and bullet points were garbled because PTY data was encoded as latin1 instead of UTF-8. Also fix terminal size mismatch in `--fg` mode (was hardcoded 120×40, now uses actual terminal dimensions).

## 0.2.0

### Minor Changes

- [`1492231`](https://github.com/marcfargas/holdpty/commit/14922318da956ecb7815383e03fdde95c3f3b470) Thanks [@marcfargas](https://github.com/marcfargas)! - Add `logs` command flags, interactive detach, PowerShell compatibility, and pi-package support.

  - **Logs flags**: `--tail N` (last N lines), `--follow`/`-f` (live streaming like `tail -f`), `--no-replay` (skip buffer history). Pipe-friendly: `holdpty logs worker --tail 20 | grep ERROR`.
  - **Detach keybinding**: Ctrl+A then d detaches from `attach` sessions (screen convention). Ctrl+A Ctrl+A sends literal Ctrl+A. Customizable via `HOLDPTY_DETACH` env var.
  - **PowerShell compatibility**: `--` separator before the command is now optional, since PowerShell strips `--` before it reaches the process.
  - **pi-package**: Installable as a pi skill via `pi install npm:holdpty`. Ships `.well-known/skills/index.json` for discovery.
  - **Fix**: Ring buffer replay now works on `attach` (previously only worked on `view`/`logs`).
