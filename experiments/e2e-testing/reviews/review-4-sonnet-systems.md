# holdpty E2E Testing — Systems/Reliability Review

## Executive Summary

This codebase is well-structured and the vision document is honest about its challenges. But I see **several things that will be flaky or outright broken in CI** that aren't called out yet. The core issues cluster around: (1) the 5-second linger timeout making tests painfully slow, (2) Windows process cleanup semantics being fundamentally different from Linux, (3) named pipe naming collisions under parallel test execution, and (4) ConPTY output non-determinism that will cause regex assertions to intermittently fail.

---

## 1. Process Lifecycle in Tests

### The 5-Second Linger Problem

**This is the #1 blocker for E2E testing.**

`holder.ts` line ~230: `shutdown()` lingers for 5 seconds after child exit before closing the server and cleaning up files:

```ts
setTimeout(() => {
  // Force-close remaining clients
  // ...
  this.server.close(() => {
    removeSession(this.name);
    this.shuttingDown = false;
  });
}, 5000);
```

Every test that exercises the full lifecycle (`launch → logs → stop → verify cleanup`) will pay a **minimum 5-second penalty** after the child exits. A 20-test suite = 100+ seconds of idle waiting. In CI with timeouts, this is a death spiral.

**Mitigation**: Add a `HOLDPTY_LINGER_MS` env var (or constructor option) defaulting to 5000 in production but overridable to `100` or `0` in tests. The linger is a grace period for late-connecting clients — tests don't need it.

### `waitForExit()` Has a Correctness Bug

```ts
waitForExit(): Promise<number> {
  return new Promise((resolve) => {
    if (this.childExited) {
      resolve(this.childExitCode ?? -1);
      return;
    }
    const check = setInterval(() => {
      if (this.shuttingDown === false && this.childExited) {
        clearInterval(check);
        resolve(this.childExitCode ?? -1);
      }
    }, 50);
```

The early-return path checks `this.childExited` but NOT `this.shuttingDown`. If the child has exited but shutdown is still in progress (the 5s linger), calling `waitForExit()` resolves immediately with the exit code *before cleanup is done*. This means `--fg` mode returns while the `.json` and `.sock` files still exist. A subsequent `ls` or `launch --name` with the same name will see a stale session.

**More subtly**: `shuttingDown` is set to `false` inside the `server.close()` callback. If the server close fails or takes time, the interval check races against it. Use a proper `Promise` / event emitter instead of polling with `setInterval`.

**Mitigation**: Replace the poll loop with a dedicated `onShutdownComplete` promise:

```ts
private shutdownDone: Promise<void>;
private resolveShutdown!: () => void;

constructor(...) {
  this.shutdownDone = new Promise(r => { this.resolveShutdown = r; });
}

waitForExit(): Promise<number> {
  return this.shutdownDone.then(() => this.childExitCode ?? -1);
}
```

### Zombie/Orphan Processes in CI

**Windows**: `cmdStop` sends `SIGTERM` via `process.kill(meta.childPid, "SIGTERM")`. On Windows, **`process.kill()` with any signal unconditionally terminates the process** — there is no signal handling. This is fine for `stop`, but it kills the **child**, not the **holder**. The holder process (which is what owns the socket and writes the metadata) is a separate PID (`meta.pid`). After the child dies, the holder enters its 5-second linger, then exits. But if the test doesn't wait for that, **the holder is orphaned**.

**Worse**: If the test process itself crashes or times out, `afterEach` never runs. Detached holder processes survive because they were spawned with `{ detached: true, stdio: 'ignore' }` and `unref()`'d.

**Concrete CI failure mode**:
1. Test A launches `--bg` → holder PID 1234 on pipe `//./pipe/holdpty-test-abc`
2. Test A times out (Vitest kills it)
3. Holder 1234 is still alive, still owns the named pipe
4. Test B tries to launch with the same name → name collision or stale metadata
5. Test B fails. Or worse, test B *connects to test A's holder*.

**Mitigations**:
- **Track all spawned holder PIDs** in a test-level `Set<number>`. In `afterEach` AND in a Vitest `globalTeardown` script, kill every tracked PID with `process.kill(pid)` (which on Windows is a hard kill).
- **Use unique session names per test** — `test-${randomUUID().slice(0,8)}` — never hardcoded names.
- **Use unique `HOLDPTY_DIR` per test file** (not per test — too many directories) — this isolates metadata.
- **Add a CI-level cleanup step** that runs after the test job regardless of success/failure:
  ```yaml
  - name: Kill orphan holdpty processes
    if: always()
    shell: bash
    run: |
      # Linux
      pkill -f "holdpty __holder" || true
      # Windows (PowerShell)
      Get-Process -Name node | Where-Object { $_.CommandLine -match '__holder' } | Stop-Process -Force
  ```

### `stop` Kills the Wrong PID on Windows

`cmdStop` does:
```ts
process.kill(meta.childPid, "SIGTERM");
```

This kills the **child** process (e.g., `cmd.exe`). On Linux, SIGTERM lets the child exit gracefully, the holder detects the exit via `onExit`, and shuts down. On Windows, `process.kill()` is an unconditional `TerminateProcess()` — the child dies instantly. But here's the problem: ConPTY may not detect the child death immediately. The holder's `onExit` callback may fire late or, in edge cases, not at all if the ConPTY handle is leaked.

**Better approach for stop**: Kill `meta.pid` (the holder process), not `meta.childPid`. The holder dying will tear down the PTY, which kills the child. Or better: connect to the holder over the socket and send a protocol-level shutdown command (not implemented yet, but more reliable than signal-based cleanup).

---

## 2. Platform-Specific Gotchas

### Named Pipes: Namespace Is Global

`socketPath` on Windows returns `//./pipe/holdpty-${name}`. Named pipes are **system-global** — every user, every session shares the `\\.\pipe\` namespace. Two CI jobs running in parallel on the same Windows runner will collide if they use the same session names. This is unlike UDS on Linux, where `HOLDPTY_DIR` provides filesystem-level isolation.

**Mitigation**: On Windows, incorporate `HOLDPTY_DIR` (or a random prefix) into the pipe name:
```ts
// Instead of:
return `//./pipe/holdpty-${name}`;
// Use:
const prefix = process.env["HOLDPTY_PIPE_PREFIX"] ?? "holdpty";
return `//./pipe/${prefix}-${name}`;
```
Tests set `HOLDPTY_PIPE_PREFIX=test-${randomId}` for full isolation.

### Named Pipe Stale Detection Is Broken

`isSocketReachable()` is used during stale detection. On Windows, it tries to `createConnection(path)` where `path` is `//./pipe/holdpty-name`. But if the holder process has died, the named pipe is gone — `createConnection` will fail with `ENOENT` or `ECONNREFUSED`. That part works.

However, `isSessionActive()` only checks `isProcessAlive(meta.pid)` — it doesn't check the pipe. And `isProcessAlive` uses `process.kill(pid, 0)`, which on Windows **can return true for a PID that has been reassigned to a different process**. PIDs are recycled aggressively on Windows. A stale session from 5 minutes ago might report as "active" because a new `node.exe` got the same PID.

**Mitigation**: On Windows, always verify via socket reachability, not just PID existence. Or store a nonce/timestamp in metadata and verify it on connect.

### `process.kill(pid, 0)` on Windows

`process.kill(pid, 0)` on Windows calls `OpenProcess(PROCESS_QUERY_INFORMATION, ...)`. This succeeds for **any** alive process the caller has access to. It does NOT verify that the process is a holdpty holder. PID reuse is real and common — Windows has a 65536 PID space that wraps.

### Signal Handling: `SIGTERM` on Windows

The existing code in `holder.ts` doesn't install any signal handlers. On Linux, a `SIGTERM` to the holder process triggers Node's default handler (exit). On Windows, `SIGTERM` via `process.kill()` is `TerminateProcess()` — instant death, no cleanup. This means:

- `removeSession(this.name)` never runs → stale `.json` files left behind
- Socket connections not closed gracefully → clients see `ECONNRESET`
- The 5s linger never happens

**For tests, this is actually fine** (fast cleanup). But for production, you need a graceful shutdown mechanism. For Windows, that typically means: a protocol-level `SHUTDOWN` message, or a signal file the holder polls, or `process.on('SIGINT')` (which Node does handle on Windows for Ctrl+C, but not for programmatic `process.kill`).

### `node-pty` in CI: Build Requirements

`node-pty` has native bindings. On GitHub Actions:
- **Ubuntu runners**: Need `build-essential` and Python. Usually pre-installed, but verify.
- **Windows runners**: Need Visual Studio Build Tools and Python. The `windows-latest` image has these, but `node-pty` may need the `windows-build-tools` npm package or specific VS version.
- **Prebuilt binaries**: If you're using `@homebridge/node-pty-prebuilt-multiarch` or similar, this is simpler. If using vanilla `node-pty`, it compiles from source on `npm install`.

**Gotcha**: `node-pty` `npm install` on Windows CI can fail silently if the build tools version mismatches. Pin your Node version in the CI matrix.

### ConPTY Output Is Non-Deterministic

ConPTY translates Win32 console API to VT sequences. The exact byte sequences depend on:
- Console buffer size
- Whether the process is the first in the ConPTY session
- Windows version (the translation has changed across builds)
- Timing of output vs. resize events

A simple `echo hello` on Windows may produce:
```
\x1b[?25l\x1b[2J\x1b[m\x1b[Hhello\r\n\x1b[?25h
```
Or something different. **Never assert on exact output from ConPTY.** 

**Mitigation**: Use marker-based assertions:
```ts
const marker = `HOLDPTY_TEST_${randomUUID().slice(0, 8)}`;
// Spawn: echo $marker
// Assert: output.includes(marker)
```

### Path Length: Named Pipes Are Fine, But...

Named pipes (`//./pipe/holdpty-name`) don't have the 108-char UDS limit. But `HOLDPTY_DIR` for metadata still needs to be short on Windows. GitHub Actions uses paths like `D:\a\holdpty\holdpty` for the workspace — that's fine. But if `HOLDPTY_DIR` defaults to `%TEMP%\dt\` and `%TEMP%` is something like `C:\Users\runneradmin\AppData\Local\Temp`, that's 45+ chars for the base before adding `dt\name.json`. Should be okay for metadata files but worth validating.

---

## 3. Timing and Race Conditions

### Race: `launch --bg` Ready-File Polling

`cmdLaunch` with `--bg` uses a ready-file mechanism:
```ts
const child = spawn(process.execPath, [...], { detached: true, stdio: 'ignore' });
child.unref();

const deadline = Date.now() + 5000;
while (Date.now() < deadline) {
  try {
    sessionName = readFileSync(readyFile, "utf-8").trim();
    unlinkSync(readyFile);
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}
```

**Race condition**: `readFileSync` can read a **partially-written file**. The holder does `writeFileSync(readyFile, holder.sessionName)` — on Linux, `writeFileSync` for small files is atomic (single `write()` syscall). On Windows with NTFS, small `writeFileSync` calls are also effectively atomic. But "effectively" is not "guaranteed." If the file is read between `CreateFile` and `WriteFile` at the OS level, you get an empty string.

**Current code handles this**: the `trim()` + check `if (!sessionName)` means an empty read retries. Good. But there's a subtler issue: what if the holder *crashes during startup* (e.g., `node-pty` fails to spawn)? The ready file is never written, the poll spins for 5 seconds, then reports "Holder did not start within 5s." **But the spawned process is still potentially alive** (it may be logging an error to stderr, which is `'ignore'`). You can't inspect what went wrong.

**Mitigation for tests**: Write both success and failure to the ready file. E.g., on startup error, write `ERROR: <message>` to the ready file. The parent reads it and can report the actual failure.

### Race: `logs` vs. Child Output

The `logs` command connects, receives the ring buffer replay, and disconnects. But the child's output arrives asynchronously through ConPTY → ring buffer. If the test does:

```ts
// 1. launch --bg -- echo hello
// 2. logs <session>
// 3. assert output contains "hello"
```

Step 2 might execute before `echo hello` has produced output through ConPTY → ring buffer. The `logs` output will be empty.

**This WILL be flaky.** ConPTY output latency is 10-200ms depending on system load. On a loaded CI runner, it can be even worse.

**Mitigation**: Poll-based assertion with exponential backoff:

```ts
async function waitForLogs(session: string, expected: string, timeoutMs = 5000): Promise<string> {
  const start = Date.now();
  let delay = 50;
  while (Date.now() - start < timeoutMs) {
    const output = execSync(`node dist/cli.js logs ${session}`).toString();
    if (output.includes(expected)) return output;
    await sleep(delay);
    delay = Math.min(delay * 1.5, 500);
  }
  throw new Error(`Timed out waiting for "${expected}" in logs of ${session}`);
}
```

### Race: Stop → ls Cleanup

After `stop`, the holder enters the 5-second linger. During that time:
- The metadata `.json` still exists
- The socket/pipe is still listening (accepting connections!)
- `isProcessAlive(meta.pid)` returns `true` (holder is still alive)
- `ls` will list the session as active

A test that does `stop → ls → assert session gone` will fail. It must wait for the full holder shutdown (5s linger + cleanup).

**Mitigation**: Either reduce linger for tests (env var), or assert differently:
```ts
// After stop, poll until session disappears
await waitUntil(() => !sessionExists(name), 10000);
```

### Race: Named Pipe Reuse on Windows

Windows named pipes are deleted when the last handle is closed. But there's a brief window between `server.close()` and the OS actually releasing the pipe name. If a test immediately creates a new session with the same pipe name, the `listen()` call may fail with `EADDRINUSE`.

**Mitigation**: Unique names per test (already recommended above), plus retry logic in test helpers.

### Race: `writeMetadata` vs. `Holder.start()` Socket Listen

In `Holder.start()`:
```ts
writeMetadata(meta);      // 1. Metadata file exists
await holder.listen(sockPath);  // 2. Socket starts listening
```

Between steps 1 and 2, another process calling `ls` or `connect()` sees the metadata, tries to connect, and gets `ECONNREFUSED`. This is a narrow window, but in tests with tight loops, it can happen.

**Mitigation**: Reverse the order — listen first, then write metadata. The metadata file is the "session exists" signal; it should only appear when the session is actually connectable.

---

## 4. Isolation

### Metadata Isolation: `HOLDPTY_DIR` per Test Suite

Set `HOLDPTY_DIR` to a temp directory per test file:

```ts
// e2e.test.ts
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const testDir = mkdtempSync(join(tmpdir(), 'holdpty-test-'));
process.env['HOLDPTY_DIR'] = testDir;

afterAll(() => {
  // rm -rf testDir
  rmSync(testDir, { recursive: true, force: true });
});
```

This isolates metadata files. But on Windows, **it does NOT isolate named pipes** because pipe names are derived from session names, not from `HOLDPTY_DIR`. Two test suites using session name `foo` will collide on `//./pipe/holdpty-foo`.

### Named Pipe Isolation (Windows-Specific)

As noted above, the pipe namespace is global. You MUST either:
1. Use unique session names (random suffix per test), OR
2. Add a pipe prefix mechanism that includes a test-unique token

I recommend both.

### `afterEach` Cleanup Contract

Every test must:
1. Track all session names it creates
2. In `afterEach`: `stop` each session, then force-kill the holder PID, then remove metadata
3. In `afterAll`: nuke the `HOLDPTY_DIR`

```ts
const sessions: string[] = [];

function trackSession(name: string) { sessions.push(name); }

afterEach(async () => {
  for (const name of sessions) {
    try { execSync(`node dist/cli.js stop ${name}`, { timeout: 2000 }); } catch {}
    const meta = readMetadataRaw(name); // direct file read
    if (meta) {
      try { process.kill(meta.pid); } catch {} // hard kill holder
      try { process.kill(meta.childPid); } catch {} // hard kill child
    }
  }
  sessions.length = 0;
});
```

### Environment Variable Leakage

Tests that set `HOLDPTY_DIR`, `HOLDPTY_DETACH`, or `HOLDPTY_PIPE_PREFIX` can interfere with each other if Vitest runs tests in the same process (which it does by default for `.test.ts` files in the same worker).

**Mitigation**: Use `vi.stubEnv()` / `vi.unstubAllEnvs()` in beforeEach/afterEach, or run E2E tests in separate worker threads (`// @vitest-environment node` + `pool: 'forks'` in vitest config).

---

## 5. CI Configuration

### GitHub Actions Matrix

```yaml
name: CI
on: [push, pull_request]

jobs:
  test:
    strategy:
      fail-fast: false  # Don't cancel other platforms on first failure
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: ['20', '22']  # LTS versions; node-pty compat varies
    
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15  # Hard cap — catches infinite hangs
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      
      # Windows: ensure build tools for node-pty native compilation
      - name: Install Windows build tools
        if: runner.os == 'Windows'
        shell: pwsh
        run: |
          # windows-latest has VS Build Tools, but ensure Python is on PATH
          python --version
      
      - run: npm ci
      - run: npm run build
      
      # Unit tests (fast, no PTY needed)
      - name: Unit tests
        run: npx vitest run --reporter=verbose src/*.test.ts
      
      # E2E tests (slow, needs PTY)
      - name: E2E tests
        run: npx vitest run --reporter=verbose test/e2e.test.ts
        timeout-minutes: 10
        env:
          HOLDPTY_LINGER_MS: '100'  # Fast cleanup for tests
      
      # Cleanup orphans (always, even on failure)
      - name: Kill orphan processes
        if: always()
        shell: bash
        run: |
          if [[ "$RUNNER_OS" == "Windows" ]]; then
            powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object { \$_.CommandLine -match '__holder' } | Stop-Process -Force -ErrorAction SilentlyContinue"
          else
            pkill -f '__holder' || true
          fi
```

### ConPTY on Windows Runners

GitHub Actions `windows-latest` (Windows Server 2022) has ConPTY. However:
- **No real console by default** — the runner executes in a service context. ConPTY still works (it doesn't need a visible console), but some behaviors differ from interactive Windows.
- **`cmd.exe` echo behavior**: `echo hello` in `cmd.exe` outputs `hello\r\n` through ConPTY, but may also include the prompt (`C:\>`) and the echo command itself (ConPTY replays console screen content, not stdout).
- **Recommendation**: Use a helper script that writes a known marker and exits, rather than relying on shell builtins:

```ts
// test/helpers/echo-marker.js
const marker = process.argv[2] ?? 'NOMARKER';
process.stdout.write(marker);
process.exit(0);
```

```ts
// In tests:
const marker = `M${randomUUID().slice(0, 8)}`;
launch('--bg', '--name', name, '--', 'node', 'test/helpers/echo-marker.js', marker);
// ... later:
const logs = getLogs(name);
expect(logs).toContain(marker);
```

This sidesteps all ConPTY/shell echoing issues. The child is a Node script that writes a known string. It's deterministic on both platforms.

### Linux PTY in CI

Ubuntu runners have `/dev/ptmx` and `forkpty` works. No special setup needed. But:
- `$XDG_RUNTIME_DIR` may not be set in CI → code falls back to `/tmp/dt-$UID/`. Verify this works.
- The runner user is `runner` (uid 1001 typically). `/tmp/dt-1001/` is fine.

### Test Separation: Unit vs E2E

Don't mix them in the same Vitest run. E2E tests are slow, spawn real processes, and can leak state. Config:

```ts
// vitest.config.e2e.ts
export default defineConfig({
  test: {
    include: ['test/e2e.test.ts'],
    testTimeout: 30000,      // 30s per test
    hookTimeout: 15000,      // 15s for afterEach cleanup
    pool: 'forks',           // Isolate each test file in a child process
    fileParallelism: false,  // Run test files sequentially (avoids pipe collisions)
  },
});
```

---

## Summary: Top 10 Actions, Ordered by Impact

| # | Issue | Severity | Effort |
|---|-------|----------|--------|
| 1 | **Add `HOLDPTY_LINGER_MS` env var** — 5s linger makes tests unusable | Blocker | Small |
| 2 | **Named pipe namespace collision** — tests will interfere on Windows | Blocker | Small |
| 3 | **Fix `waitForExit()` poll-vs-promise race** | Bug | Medium |
| 4 | **Reverse metadata write / socket listen order** in `Holder.start()` | Bug | Trivial |
| 5 | **Use marker-based assertions** (Node helper scripts, not shell builtins) | Flaky tests | Small |
| 6 | **Poll-based log assertions** with backoff, never fixed sleeps | Flaky tests | Small |
| 7 | **Track + force-kill all holder PIDs in test teardown** | CI reliability | Medium |
| 8 | **`stop` should kill holder PID, not child PID** (or both) | Bug | Small |
| 9 | **CI matrix with orphan cleanup step** | CI reliability | Small |
| 10 | **PID reuse on Windows** — don't trust `process.kill(pid, 0)` alone | Correctness | Medium |

Items 1-4 are code changes that should happen before writing any E2E tests. Items 5-6 are test design patterns. Items 7-9 are CI infrastructure. Item 10 can be deferred but will bite eventually.
