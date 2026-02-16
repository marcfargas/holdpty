---
"holdpty": patch
---

Fix Unicode corruption in PTY output. Characters like `π`, `↑↓←→`, box-drawing lines, and bullet points were garbled because PTY data was encoded as latin1 instead of UTF-8. Also fix terminal size mismatch in `--fg` mode (was hardcoded 120×40, now uses actual terminal dimensions).
