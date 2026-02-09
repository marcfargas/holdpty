# holdpty E2E Testing — Vision

## Problem

holdpty has 52 unit/integration tests that verify internal modules (ring buffer, protocol, session, holder class). But nothing tests the actual CLI binary end-to-end — the way a user or agent would invoke it. Key gaps:

1. **`launch --bg` → `ls` → `logs` → `stop` lifecycle** is only smoke-tested manually
2. **`attach` with detach keybinding** is untested (requires interactive PTY + raw mode)
3. **`view` with live streaming** is untested
4. **`launch --fg` exit code propagation** is untested as a CLI
5. **Cross-platform behavior** (Windows named pipes vs Linux UDS) is only tested at the library level

## Goal

Design an E2E test suite that exercises the CLI binary (`node dist/cli.js`) through real shell invocations, covering the full session lifecycle on both Windows and Linux.

## Constraints

### Hard constraints
- **Platform**: Must work on Windows (primary, ConPTY) + Linux (CI). No macOS yet.
- **Test runner**: Vitest (already in devDeps)
- **No external deps for testing**: Prefer not adding Playwright, expect, or similar. Keep it minimal.
- **Timeout safety**: Tests must not hang. Every test needs explicit timeouts.
- **CI**: Tests will run in GitHub Actions (Ubuntu + Windows runners). No real TTY in CI.

### Challenges

1. **Interactive attach**: `attach` enters raw mode on stdin, takes over the terminal. Cannot be tested from a non-TTY test process. stdin.isTTY will be false in CI.
2. **PTY output includes ConPTY noise**: Windows ConPTY wraps output in escape sequences, cursor control, window titles, etc. Asserting exact output is fragile.
3. **Timing**: PTY output is async. `logs` reads whatever is in the ring buffer at the time of connection. Need to wait for the child to produce output before reading.
4. **Process cleanup**: Background sessions (holder processes) must be killed in afterEach/afterAll. Leaked processes break CI.
5. **Named pipes (Windows) vs UDS (Linux)**: Socket paths differ per platform, but the CLI abstracts this. Tests should be platform-agnostic.
6. **node-pty in CI**: GitHub Actions Windows runners have ConPTY. Linux runners have forkpty. But the PTY environment may differ from local dev.
7. **`launch --bg` is async**: The holder process starts in the background. Need to wait for the ready-file signal or poll `ls` before proceeding.
8. **`attach` with detach**: To test attach → type input → detach, we'd need to simulate a TTY with raw mode. `child_process.spawn` with `stdio: 'pipe'` won't have isTTY=true.

## Current Architecture

```
src/
  cli.ts              → entry point (node dist/cli.js)
  holder.ts           → Holder class (PTY + socket)
  client.ts           → attach(), view(), logs()
  protocol.ts         → wire protocol
  ring-buffer.ts      → circular buffer
  session.ts          → metadata, listing
  platform.ts         → paths
  integration.test.ts → tests Holder class in-process
```

The existing integration tests create a `Holder` instance directly and connect to it via the `connect()` function. They don't go through the CLI.

## What Needs E2E Coverage

### Priority 1 — Must have
- [ ] `launch --bg` → session appears in `ls`
- [ ] `logs <session>` → contains expected output from child
- [ ] `stop <session>` → session disappears from `ls`
- [ ] `launch --fg` → exits with child's exit code
- [ ] `ls --json` → valid JSON, correct schema
- [ ] `info <session>` → valid JSON with expected fields
- [ ] Stale session cleanup (kill holder PID, then `ls` should clean up)

### Priority 2 — Should have
- [ ] `view <session>` → receives live data (connect, read some, disconnect)
- [ ] Multiple `view` connections simultaneously
- [ ] `launch --bg` auto-generated name (no --name flag)
- [ ] Error cases: stop nonexistent session, attach nonexistent session, launch with no command

### Priority 3 — Nice to have (may need special approach)
- [ ] `attach` → type input → see response → detach with Ctrl+] d
- [ ] `attach` exclusivity (second attach fails)
- [ ] Resize propagation during attach
- [ ] `launch --fg` with interactive program (e.g., a REPL)

## Open Questions

1. **How to test `attach`?** It requires a TTY. Options:
   - Skip in CI, manual-only
   - Use holdpty itself to create a PTY for the test process (meta!)
   - Use a helper that fakes isTTY (monkey-patch, or a wrapper)
   - Use `script` command (Linux) or `winpty` (Windows) to provide a PTY
   - Test at the library level only (current integration tests)

2. **How to handle ConPTY output noise?** Options:
   - Strip ANSI/VT escape sequences before asserting
   - Use `includes()` / regex instead of exact match
   - Assert on specific markers embedded in the child command

3. **Test isolation**: Each test creates/destroys sessions. Options:
   - Use unique `HOLDPTY_DIR` per test (metadata isolation)
   - Use unique session names with random suffixes
   - Both

4. **How to wait for async output?** The child writes to the PTY, which goes through ConPTY, to the ring buffer. There's latency. Options:
   - Fixed sleep (fragile, slow)
   - Poll `logs` until expected content appears (retry loop)
   - Poll with exponential backoff + timeout

5. **Should E2E tests be in a separate file or directory?**
   - `src/e2e.test.ts` (alongside other tests)
   - `test/e2e.test.ts` (separate directory)
   - `src/__e2e__/` (vitest convention)

6. **Test matrix**: Should E2E tests explicitly test Windows-specific and Linux-specific behavior, or stay platform-agnostic?
