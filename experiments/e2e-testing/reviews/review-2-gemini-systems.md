# holdpty E2E Testing — Systems/Reliability Review

## Executive Summary

This codebase has a well-thought-out architecture but the E2E test surface is **full of platform-specific landmines**. The five hardest problems, in order of "will ruin your week": (1) the 5-second linger timeout in `shutdown()` making every test that stops a session take ≥5s, (2) named pipes being fundamentally undetectable via filesystem on Windows, (3) orphan holder processes in CI, (4) ConPTY output nondeterminism, and (5) `process.kill(pid, 0)` being unreliable for stale detection on Windows. Below is a full breakdown.

---

## 1. Process Lifecycle in Tests

### 1.1 The 5-Second Linger Is a Test Killer

**Problem**: `holder.ts:shutdown()` has a hardcoded 5-second linger timeout before closing the server and cleaning up files:

```typescript
// holder.ts line ~210
setTimeout(() => {
  // Force-close remaining clients
  // ...
  this.server.close(() => {
    removeSession(this.name);
    this.shuttingDown = false;
  });
}, 5000);
```

Every test that exercises `stop` or waits for a child to exit will block **at least 5 seconds** per session. A suite of 15 tests = 75+ seconds of pure waiting. In CI with matrix (Windows + Linux), that's 150+ seconds of idle hanging.

**Mitigation**:
- Make the linger duration configurable: `HOLDPTY_LINGER_MS` env var, defaulting to 5000 in production, set to `100` or `0` in tests.
- Alternatively, add a method `Holder.shutdownImmediate()` for testing, or make the linger a constructor option.
- This is **the single most impactful change** for test feasibility.

### 1.2 Spawning and Waiting for `--bg` Holders

**Problem**: `launch --bg` spawns a detached process and polls a ready-file. This works, but in tests you need to:
1. Know the holder PID (to kill it in cleanup)
2. Wait for the socket to be connectable (not just for the ready-file to exist)

The ready-file contains the session name, but `Holder.start()` writes metadata and listens on the socket *before* the ready-file is written (see `cmdHolder()`). So by the time you read the ready-file, the socket should be live. However, there's a TOCTOU: the `writeFileSync(readyFile, ...)` in `cmdHolder` happens after `Holder.start()` resolves, so there's a narrow window where the ready-file exists but hasn't been flushed by the OS. On Windows with antivirus, file writes can be delayed.

**Mitigation**:
- After reading the ready-file, do one `logs` or `info` call to confirm the session is reachable before proceeding.
- Use `HOLDPTY_DIR` per test (see isolation section) so you can enumerate exactly what's running.

### 1.3 Killing Holders in afterEach

**Problem**: The `stop` command sends `SIGTERM` to the **child PID** (`meta.childPid`), not the holder PID (`meta.pid`). On Linux, `SIGTERM` to the child causes the PTY to close, triggering `onExit`, then `shutdown()` (with the 5s linger). On Windows, `process.kill(pid, 'SIGTERM')` sends `TerminateProcess` — which is more like `SIGKILL`. It kills the child, but the holder process is separate and detached.

**The real cleanup problem**: After killing the child, the holder enters the `shutdown()` path with 5s linger. If the test calls `afterEach` and tries to kill the holder PID too, you get a race between `shutdown()` cleanup and external kill. This can leave stale `.json` files.

**Mitigation**:
```typescript
// Test cleanup helper
async function forceKillSession(name: string, timeoutMs = 2000): Promise<void> {
  const meta = readMetadata(name);
  if (!meta) return;
  
  // Kill holder process (not child — holder will clean up)
  try { process.kill(meta.pid, 'SIGTERM'); } catch {}
  
  // Wait for metadata to disappear (holder cleans up on exit)
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!readMetadata(name)) return;
    await sleep(50);
  }
  
  // Force: kill both and clean up manually
  try { process.kill(meta.pid, 'SIGKILL'); } catch {}
  try { process.kill(meta.childPid, 'SIGKILL'); } catch {}
  removeSession(name);
}
```

### 1.4 Zombie/Orphan Processes in CI

**Problem**: If a test times out or crashes, detached holder processes survive. On GitHub Actions:
- Linux: Orphaned processes persist until the runner container exits. Multiple failed test runs can accumulate holders.
- Windows: Detached processes persist across steps in the same job. `TerminateProcess` is abrupt — the holder's `shutdown()` never runs, leaving stale metadata.

**Mitigation**:
1. **Global afterAll**: Kill all processes whose PIDs are in `HOLDPTY_DIR/*.json`:
   ```typescript
   afterAll(async () => {
     const dir = getSessionDir();
     for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
       const meta = JSON.parse(readFileSync(join(dir, file), 'utf-8'));
       try { process.kill(meta.pid, 'SIGKILL'); } catch {}
       try { process.kill(meta.childPid, 'SIGKILL'); } catch {}
     }
     rmSync(dir, { recursive: true, force: true });
   });
   ```
2. **CI step**: Add a post-test cleanup step:
   ```yaml
   - name: Kill orphan holders
     if: always()
     shell: bash
     run: |
       # Linux
       pkill -f "__holder" || true
       # Windows
       taskkill /F /FI "WINDOWTITLE eq holdpty*" 2>nul || true
       # or by image name if you know the node binary
   ```
3. **Test timeout**: Vitest's `testTimeout` should be aggressive (10s per test, 60s for the suite). Tests that hit timeout leave orphans — the global cleanup catches them.

### 1.5 `waitForExit()` Polling Is Fragile

The current `waitForExit()` polls `this.childExited` every 50ms but also checks `this.shuttingDown === false`. The logic is subtle:

```typescript
if (this.shuttingDown === false && this.childExited) {
```

This means it waits for `shuttingDown` to flip back to `false` after cleanup completes — which happens **inside the `server.close()` callback** after the 5s linger. So `waitForExit()` always takes ≥5 seconds. This is by design (per DESIGN.md's linger spec) but crippling for tests.

**Mitigation**: Emit an event (`EventEmitter`) instead of polling. Use the configurable linger for tests.

---

## 2. Platform-Specific Gotchas

### 2.1 Named Pipes Are Invisible to the Filesystem

**Problem**: On Windows, `socketPath()` returns `//./pipe/holdpty-<name>`. Named pipes:
- Don't appear in `readdirSync()`
- Can't be checked with `existsSync()`
- Don't leave files after close (no stale `.sock` to clean)
- Have different access semantics (no `unlink`, no file locks in the UDS sense)

The code handles this correctly in `session.ts` (stale detection uses `isProcessAlive` on Windows instead of checking `.sock` files). But tests that verify socket cleanup or stale detection need platform-aware assertions.

**What breaks in tests**: Any assertion like "after stop, the socket file should not exist" is meaningless on Windows. Stale detection that tries to `createConnection` to a named pipe whose holder is dead will get `ENOENT` on Windows (instant) vs. `ECONNREFUSED` on Linux (instant) vs. timeout on macOS (slow). The 100ms timeout in `isSocketReachable` is adequate.

### 2.2 `process.kill(pid, 0)` on Windows

**Problem**: `isProcessAlive()` uses `process.kill(pid, 0)`. On Windows:
- Node.js uses `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` — this works but can return `true` for PIDs that are being torn down (process handle still valid, but process is exiting).
- If the test just killed a process, `isProcessAlive` may still return `true` for a few hundred milliseconds.
- PID reuse on Windows is more aggressive than Linux (PIDs come from a small pool). A test that checks "PID is dead" could get a false positive if the PID was reassigned.

**Mitigation**: After killing, poll with `isProcessAlive` + a deadline rather than a single check. For stale detection tests, add a delay or retry loop.

### 2.3 `SIGTERM` vs. `TerminateProcess`

**Problem**: `cmdStop` sends `process.kill(meta.childPid, 'SIGTERM')`. On Windows, Node.js translates `SIGTERM` to `TerminateProcess()`, which:
- Cannot be caught or handled by the child
- Is equivalent to `SIGKILL` on Linux
- Kills the child **immediately** — no graceful shutdown
- May not kill the ConPTY process tree (ConPTY spawns intermediate `conhost.exe`)

**What breaks**: On Linux, `SIGTERM` to the child triggers graceful exit → PTY `onExit` → `shutdown()`. On Windows, `TerminateProcess` may kill the child but leave `conhost.exe` alive, and the PTY `onExit` event might fire with a delay or not at all (depending on node-pty's ConPTY handling).

**Mitigation**:
- Test `stop` behavior separately on each platform
- On Windows, verify the holder PID dies (not just the child PID)
- Consider killing the holder PID instead of/in addition to the child PID for `stop`
- In tests, use `taskkill /T /PID` (tree kill) on Windows as a fallback

### 2.4 ConPTY Output Noise

**Problem**: ConPTY wraps output in:
- Window title escape sequences (`\x1b]0;...\x07`)
- Cursor position sequences (`\x1b[?25h`, `\x1b[H`)
- CRLF line endings (vs LF on Linux)
- Extra blank lines and spaces (ConPTY pads to terminal width)

A child running `echo hello` produces ~20 bytes on Linux but ~200+ bytes on Windows.

**Mitigation — strip and match**:
```typescript
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences
          .replace(/\x1b\][^\x07]*\x07/g, '')        // OSC sequences
          .replace(/\x1b[()][0-9A-B]/g, '')           // charset
          .replace(/\r\n/g, '\n')                     // normalize CRLF
          .replace(/\r/g, '');                         // stray CR
}

// Then assert with:
expect(stripAnsi(output)).toContain('hello');
```

Never use exact-match assertions on PTY output. Always use `toContain()` or regex with a unique marker.

### 2.5 `echo` Behaves Differently

**Problem**: `echo hello` means different things:
- Linux (`/bin/sh -c "echo hello"`): prints `hello\n`
- Windows (`cmd.exe /c echo hello`): prints `hello\r\n` plus the prompt, plus the command echo
- PowerShell: prints `hello\n` but with different encoding

**Mitigation**: Use a Node.js one-liner as the child command in tests:
```bash
node -e "process.stdout.write('MARKER_abc123')"
```
This is deterministic, cross-platform, and produces exactly the bytes you specify. No shell interpretation, no CRLF ambiguity in the payload itself (ConPTY will still wrap it, but the marker is findable).

### 2.6 Path Length on Windows CI

Named pipes use `//./pipe/holdpty-<name>`, which avoids the 108-char UDS limit. But `HOLDPTY_DIR` for metadata files could be long if the CI workspace path is deep. GitHub Actions Windows runners use paths like `D:\a\holdpty\holdpty\...`.

**Mitigation**: Set `HOLDPTY_DIR` to a short temp path in CI: `$RUNNER_TEMP\dt-test` or similar.

---

## 3. Timing and Race Conditions

### 3.1 The Fundamental Race: PTY Output Is Async

When a test does:
```
launch --bg -- node -e "console.log('hello')"
# ...then immediately...
logs <session>
```

The `logs` command connects, replays the ring buffer, and disconnects. But if the child hasn't produced output yet (or the output hasn't traversed ConPTY → node-pty → RingBuffer), the logs will be empty.

**Severity**: HIGH. This is the #1 source of flakiness in PTY-based tests.

**Mitigation — Poll-until-match**:
```typescript
async function waitForLogs(
  sessionName: string,
  marker: string,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = execSync(
      `node dist/cli.js logs ${sessionName}`,
      { encoding: 'utf-8', env: { ...process.env, HOLDPTY_DIR: testDir } }
    );
    if (stripAnsi(output).includes(marker)) return output;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for "${marker}" in logs`);
}
```

Use unique markers per test: `MARKER_${testId}_${randomHex}`.

### 3.2 Race Between `--bg` Ready-File and Socket Readiness

The `cmdHolder` function calls `Holder.start()` (which creates the socket and starts listening) and then writes the ready-file. The parent polls the ready-file. There's a window where:
1. `Holder.start()` resolves — socket is listening
2. **Ready-file not yet written** (between `start()` return and `writeFileSync`)
3. Parent is still polling

This is fine because the parent waits for the file. But the inverse race is possible on slow Windows CI:
1. `writeFileSync(readyFile, ...)` completes
2. Parent reads it
3. Parent immediately calls `logs` or `ls`
4. The holder's `setupServer()` hasn't run yet? No — `setupServer()` is called inside `start()` before returning. So the socket should be ready.

**Verdict**: The current ready-file mechanism is **sound** for socket readiness. The race is only on PTY output (3.1 above).

### 3.3 Race in `ls --clean` During Concurrent Tests

If two tests run concurrently and both call `ls --clean`, they could both detect the same stale session and both try to `removeSession()`. This is harmless (double `unlinkSync` throws, caught by the `try/catch`). But if test A's session is detected as stale by test B's `ls --clean` (because A's holder hasn't written metadata yet), test B could delete test A's session.

**Mitigation**: Isolate `HOLDPTY_DIR` per test file (not per test case — that's too many directories). See isolation section.

### 3.4 Race in `shutdown()` Client Notification

During `shutdown()`, the holder sends EXIT frames and calls `socket.end()` for each client. But `socket.end()` is async — the TCP stack buffers the write. If the holder process is killed before the OS flushes the write buffer, clients never receive the EXIT frame.

**Impact on tests**: A test that does `stop` and then checks the `view` client's exit behavior may not receive the EXIT frame. The client will see `close` event instead, resolving `done` with `null`.

**Mitigation**: In tests, don't assert on receiving the EXIT frame after `stop`. Assert on session disappearance (metadata file removed or `ls` no longer shows it).

### 3.5 Child Exit vs. `onData` Race (node-pty Known Issue)

From AGENTS.md: "node-pty onExit fires before last onData". The holder already handles this with a drain delay (100ms Linux, 200ms Windows). But in tests, if you kill a child that's producing output and then immediately check `logs`, you might miss the final output.

**Mitigation**: The drain delay handles it for the holder, but tests should use the poll-until-match pattern (3.1) rather than assuming output is complete after child exit.

---

## 4. Isolation

### 4.1 `HOLDPTY_DIR` Per Test Suite

**Requirement**: Each test file must use its own `HOLDPTY_DIR` to prevent:
- Session name collisions
- Stale cleanup interfering across tests
- Metadata files from one test confusing another

```typescript
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'holdpty-test-'));
  process.env.HOLDPTY_DIR = testDir;
});

afterAll(() => {
  // Kill any remaining sessions (see 1.4)
  // ...
  rmSync(testDir, { recursive: true, force: true });
  delete process.env.HOLDPTY_DIR;
});
```

### 4.2 Named Pipe Conflicts on Windows

**Problem**: Named pipes use `//./pipe/holdpty-<name>`. If two tests use the same session name (e.g., `test-session`), they'll fight over the same named pipe, even with different `HOLDPTY_DIR` values. **`HOLDPTY_DIR` only isolates metadata files, not the pipe namespace.**

**Severity**: CRITICAL. This will cause intermittent test failures on Windows.

**Mitigation**: Session names in tests must be globally unique. Use a prefix with a random component:
```typescript
function uniqueName(prefix: string): string {
  return `${prefix}-${process.pid}-${Date.now().toString(36)}`;
}
```

Or — better — make `socketPath()` incorporate `HOLDPTY_DIR` into the pipe name:
```typescript
// platform.ts — proposed fix
export function socketPath(sessionDir: string, name: string): string {
  if (IS_WINDOWS) {
    // Hash the session dir to namespace the pipe
    const hash = createHash('md5').update(sessionDir).digest('hex').slice(0, 8);
    return `//./pipe/holdpty-${hash}-${name}`;
  }
  return join(sessionDir, `${name}.sock`);
}
```

This makes `HOLDPTY_DIR` isolation actually work on Windows.

### 4.3 `process.env` Mutation in Tests

**Problem**: Setting `process.env.HOLDPTY_DIR` in tests affects the current process globally. If Vitest runs tests in parallel (default), one test file's `beforeAll` can overwrite another's env.

**Mitigation**: Vitest runs each test file in its own worker by default (`--pool=forks` or `--pool=threads`). With `forks` (default on Node 18+), `process.env` is isolated per file. Verify this is configured:
```typescript
// vitest.config.ts
export default defineConfig({
  test: {
    pool: 'forks',           // process-level isolation
    testTimeout: 15000,       // generous per-test timeout
    hookTimeout: 10000,
    fileParallelism: false,   // serialize test files — avoid pipe name collisions
  },
});
```

**Warning**: `fileParallelism: false` is **required** on Windows to avoid named pipe collisions (even with the hash fix above, race conditions on pipe creation are possible). On Linux, parallel is fine with isolated `HOLDPTY_DIR`.

### 4.4 Stale Ready-Files

The `--bg` launch creates `.ready-*` temp files in `HOLDPTY_DIR`. If the holder crashes before writing the file, or the test times out, these files linger. They're small but accumulate.

**Mitigation**: The `afterAll` cleanup already `rmSync`s the entire test dir. No action needed beyond that.

---

## 5. CI Configuration

### 5.1 GitHub Actions Matrix

```yaml
name: E2E Tests
on: [push, pull_request]

jobs:
  e2e:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: ['18', '20', '22']
    
    runs-on: ${{ matrix.os }}
    timeout-minutes: 10
    
    steps:
      - uses: actions/checkout@v4
      
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      
      - run: npm ci
      - run: npm run build
      
      - name: Run E2E tests
        run: npx vitest run --reporter=verbose src/e2e.test.ts
        timeout-minutes: 5
        env:
          HOLDPTY_DIR: ${{ runner.temp }}/dt-test
          # Reduce linger for tests
          HOLDPTY_LINGER_MS: '100'
      
      - name: Kill orphan holders
        if: always()
        shell: bash
        run: |
          if [[ "$RUNNER_OS" == "Windows" ]]; then
            tasklist /FI "IMAGENAME eq node.exe" /FO CSV 2>nul | \
              grep -i "__holder" && taskkill /F /IM node.exe /FI "WINDOWTITLE eq *" || true
          else
            pkill -f "__holder" || true
          fi
```

### 5.2 node-pty Native Build on CI

**Problem**: `node-pty` requires native compilation. On GitHub Actions:
- **Linux**: Needs `build-essential` and `python3`. Ubuntu runners have these.
- **Windows**: Needs Visual Studio Build Tools. Windows runners have these (`windows-latest` includes VS 2022).
- **BUT**: If using prebuilt binaries (the `prebuilds` directory in package.json `files`), native build may be skipped. Ensure `npm ci` doesn't try to rebuild from source in CI.

**Mitigation**: 
- If shipping prebuilds: verify they cover CI's exact platform + Node ABI version
- If building from source: add this for Windows:
  ```yaml
  - name: Setup Windows build tools
    if: runner.os == 'Windows'
    uses: anthropics/setup-msvc@v1  # or microsoft/setup-msbuild
  ```
- Test with `node -e "require('node-pty')"` as a smoke check before running E2E.

### 5.3 ConPTY Availability

GitHub Actions Windows runners (`windows-latest` = Server 2022) have ConPTY. No special setup needed. However:
- ConPTY behavior on Server 2022 may differ slightly from Windows 10/11 desktop (different `conhost.exe` version)
- The default terminal size may differ from local dev
- There's no GUI session — but ConPTY doesn't need one (it's headless by design)

### 5.4 No Real TTY in CI

GitHub Actions provides no TTY on stdin. This means:
- `process.stdin.isTTY === undefined` (not `false` — `undefined`)
- `attach` will throw `"attach requires a TTY"`
- `view` works fine (doesn't need a TTY)
- `logs` works fine

**Mitigation for attach tests**: Skip in CI, or test at the library level (the existing integration tests already do this).

```typescript
const hasTTY = process.stdin.isTTY === true;
describe.skipIf(!hasTTY)('attach (interactive)', () => {
  // ...
});
```

### 5.5 Windows `cmd.exe` vs. `bash` Shell in `execSync`

When tests use `execSync()` or `spawn()` to run `node dist/cli.js`, the shell matters:
- `execSync(cmd, { shell: true })` uses `cmd.exe` on Windows, `/bin/sh` on Linux
- `cmd.exe` has different quoting, `echo` behavior, env var syntax
- GitHub Actions `shell: bash` steps use Git Bash, which is different from both

**Mitigation**: Don't use `shell: true`. Spawn `node` directly:
```typescript
execFileSync('node', ['dist/cli.js', 'launch', '--bg', '--name', name, '--', ...command], {
  env: { ...process.env, HOLDPTY_DIR: testDir },
  encoding: 'utf-8',
});
```

---

## Summary: The Flakiness Leaderboard

| Issue | Severity | Platform | Fix Complexity |
|---|---|---|---|
| Named pipe namespace collision (4.2) | 🔴 Critical | Windows | Medium — change `socketPath()` |
| 5-second linger blocks every test (1.1) | 🔴 Critical | Both | Low — make configurable |
| PTY output timing (3.1) | 🟠 High | Both | Low — poll-until-match pattern |
| Orphan processes in CI (1.4) | 🟠 High | Both | Medium — cleanup hooks + CI step |
| ConPTY output noise (2.4) | 🟡 Medium | Windows | Low — strip function + `toContain` |
| `SIGTERM` semantics differ (2.3) | 🟡 Medium | Windows | Low — kill holder PID |
| `process.kill(pid,0)` timing (2.2) | 🟡 Medium | Windows | Low — retry loops |
| `echo` cross-platform (2.5) | 🟢 Low | Both | Low — use `node -e` |
| No TTY for attach tests (5.4) | 🟢 Low | Both | None — skip in CI |

### Recommended Implementation Order

1. **Make linger configurable** — unblocks all tests
2. **Fix named pipe namespacing** — without this, Windows tests are broken by design
3. **Write test utilities** (`uniqueName`, `waitForLogs`, `stripAnsi`, `forceKillSession`)
4. **Set up `HOLDPTY_DIR` isolation** per test file with full `afterAll` cleanup
5. **Write the first 3 tests** (launch-bg → ls → logs → stop) using poll-until-match
6. **CI matrix** with orphan-kill step
7. **Expand to remaining test cases**
