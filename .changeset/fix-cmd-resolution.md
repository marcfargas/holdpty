---
"holdpty": patch
---

Fix launching `.cmd`/`.bat` commands on Windows (e.g., `pi`, `npm`). node-pty can't execute script shims directly — they are now wrapped with `cmd.exe /c` automatically while native `.exe` commands are spawned directly.
