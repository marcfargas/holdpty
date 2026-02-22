---
"holdpty": minor
---

Add `--wait` flag and `holdpty wait` command for Docker entrypoint use case.

- `holdpty launch --wait -- cmd`: launch a detached PTY session and wait for the inner process to exit, returning its exit code. PID 1 stays alive while clients can attach/view the session.
- `holdpty wait <session>`: wait for an existing session's inner process to exit and return its exit code.
- Signal forwarding: SIGTERM/SIGINT received by the wait process are forwarded to the child process for graceful shutdown.
- New `wait` protocol mode: skips buffer replay and DATA_OUT broadcast for efficient exit-code-only connections.
