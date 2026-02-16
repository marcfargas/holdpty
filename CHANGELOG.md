# holdpty

## 0.2.0

### Minor Changes

- [`1492231`](https://github.com/marcfargas/holdpty/commit/14922318da956ecb7815383e03fdde95c3f3b470) Thanks [@marcfargas](https://github.com/marcfargas)! - Add `logs` command flags, interactive detach, PowerShell compatibility, and pi-package support.

  - **Logs flags**: `--tail N` (last N lines), `--follow`/`-f` (live streaming like `tail -f`), `--no-replay` (skip buffer history). Pipe-friendly: `holdpty logs worker --tail 20 | grep ERROR`.
  - **Detach keybinding**: Ctrl+A then d detaches from `attach` sessions (screen convention). Ctrl+A Ctrl+A sends literal Ctrl+A. Customizable via `HOLDPTY_DETACH` env var.
  - **PowerShell compatibility**: `--` separator before the command is now optional, since PowerShell strips `--` before it reaches the process.
  - **pi-package**: Installable as a pi skill via `pi install npm:holdpty`. Ships `.well-known/skills/index.json` for discovery.
  - **Fix**: Ring buffer replay now works on `attach` (previously only worked on `view`/`logs`).
