---
"holdpty": patch
---

Fix `launch --fg` not showing interactive terminal. The PTY was running but stdin/stdout were never connected, leaving the user with a blank screen. Foreground mode now bridges I/O directly to the PTY with raw mode and resize support.
