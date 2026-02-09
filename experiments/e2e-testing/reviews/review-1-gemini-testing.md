Now I have the complete picture. Let me write the review.

---

# E2E Testing Vision — Critical Review

## 1. Testing Strategy: Priority Assessment

### What's right

The Priority 1 list correctly identifies the **lifecycle smoke path** (`launch --bg → ls → logs → stop`) as the most important E2E gap. This is the exact path an agent or user hits first, and it's currently only manually tested. Exit code propagation for `--fg` is also critical — it's the contract for CI pipelines.

### What's wrong or missing

**Over-scoped items in Priority 2:**
- "Multiple `view` connections simultaneously" — already tested in `integration.test.ts` (`test-multiview`). E2E adds nothing here; the CLI just calls `view()` which calls `connect()`. Same socket, same holder. Don't re-test it.
- "Auto-generated name" — also already tested. The E2E value is marginal (verifying `stdout` output format, but that's a 2-line check in the lifecycle test).

**Missing from all priorities:**
- **CLI argument validation and error messages**: `holdpty launch` with no `--fg`/`--bg`, `holdpty launch --fg --bg`, `holdpty launch --bg` with no `--`, `holdpty stop nonexistent`. These are cheap to test and prevent regressions on the arg parser (which is hand-rolled, no framework).
- **`--help` and `--version` output**: Trivial, but they're the first thing a user runs. Two assertions.
- **Exit codes on error**: The design doc specifies exit code contracts. `stop` on a dead session, `attach` on nonexistent — do they return non-zero? `die()` calls `process.exit(1)`, but this is untested.
- **`launch --bg` stdout contract**: The design doc says `--bg` prints session name to stdout (for `SESSION=$(holdpty launch --bg -- cmd)`). This is the shell-scripting contract. Must be tested E2E.
- **Concurrent `launch --bg` with same `--name`**: What happens? Race condition? Error? The current code doesn't guard against this at the CLI level.

**Over-scoped for MVP:**
- Priority 3's "Resize propagation during attach" and "attach exclusivity" — already covered at the library level. Resize during attach is Phase 2 per DESIGN.md. Don't test what you haven't shipped.
- "Stale session cleanup" in Priority 1 is valuable but tricky: you need to kill a holder process by PID and then assert `ls` cleans it up. Platform-specific PID killing. I'd move this to Priority 2.

### Revised priority list

| Priority | Test | Rationale |
|----------|------|-----------|
| **P1** | `launch --bg` → stdout is session name | Shell-scripting contract |
| **P1** | `launch --bg` → `ls` shows session | Core lifecycle |
| **P1** | `launch --bg` → `logs` contains expected output | Core lifecycle |
| **P1** | `launch --bg` → `stop` → `ls` empty | Core lifecycle |
| **P1** | `launch --fg` → exits with child's exit code | CI pipeline contract |
| **P1** | `ls --json` → valid JSON, correct schema | Machine-readable output |
| **P1** | `info <session>` → valid JSON, expected fields | Machine-readable output |
| **P1** | CLI error cases (no args, bad args, bad session) → exit 1 + stderr | Robustness |
| **P1** | `--help` / `--version` | Smoke test |
| **P2** | `view` → receives live data, exits on child death | Live streaming |
| **P2** | `logs` on session with no output → empty, exits 0 | Edge case |
| **P2** | Stale session cleanup via `ls` | Filesystem registry integrity |
| **P2** | `launch --bg` duplicate name → error | Guard against corruption |
| **P3** | `attach` → type → see response → detach | Interactive (needs PTY wrapper) |
| **P3** | `attach` → child exits → returns exit code | Interactive |

## 2. The Attach Problem

### Evaluation of each option from the vision doc

**Option A: "Skip in CI, manual-only"**
Pragmatic but defeats the purpose. `attach` is the headline feature. If it breaks, you find out from a user, not CI. **Reject.**

**Option B: "Use holdpty itself to create a PTY for the test" (meta)**
Circular dependency. If holdpty is broken, the test harness is broken. You can't debug which layer failed. **Reject.**

**Option C: "Monkey-patch isTTY"**
You can set `process.stdin.isTTY = true`, but `setRawMode()` will throw because there's no actual TTY fd underneath. You'd need to mock `setRawMode` too. At that point you're testing a mock, not the real code. **Reject for E2E** (fine for unit tests of the detach sequence parser if you extract it).

**Option D: "Use `script` (Linux) or `winpty` (Windows)"**
`script` works on Linux CI but is not available on Windows. `winpty` is an extra dep and largely obsoleted by ConPTY. Platform-specific test code for a cross-platform tool. **Reject.**

**Option E: "Test at library level only"**
This is what the existing integration tests already do. They test attach protocol, exclusivity, data flow. The E2E gap is specifically the CLI-level raw mode + detach keybinding. **Already done; doesn't close the gap.**

### My proposal: **Use node-pty from the test harness**

node-pty is already a dependency. The test spawns a real PTY process running `node dist/cli.js attach <session>`. Inside that PTY, `process.stdin.isTTY` is `true` and `setRawMode` works. The test writes bytes to the PTY's stdin and reads from its stdout. This is:

- **Cross-platform**: node-pty works on Windows (ConPTY) and Linux (forkpty). Same API.
- **Real**: The CLI runs in an actual PTY. No mocks. Raw mode works. Detach sequence works.
- **CI-compatible**: GitHub Actions runners support ConPTY (Windows) and forkpty (Linux). No real terminal needed — node-pty creates its own.
- **Already a dependency**: Zero new deps.

```typescript
import * as pty from 'node-pty';

function spawnCliInPty(args: string[], env: Record<string, string>): pty.IPty {
  return pty.spawn(process.execPath, ['dist/cli.js', ...args], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    env: { ...process.env, ...env },
  });
}

// Test: attach, type, see echo, detach
const p = spawnCliInPty(['attach', sessionName], { HOLDPTY_DIR: testDir });

let output = '';
p.onData(data => { output += data; });

// Type a command
p.write('echo hello-marker\r');
await waitFor(() => output.includes('hello-marker'));

// Detach: Ctrl+] then d
p.write('\x1dd');
await waitFor(() => p.exitCode !== undefined);
// exitCode should be 0 (detach, not child exit)
```

**Caveat**: node-pty's `onData` on Windows includes ConPTY noise (window title sequences, cursor positioning). This is fine — we're asserting with `includes()`, not exact match (see Section 3).

**Caveat 2**: The test is now spawning TWO PTY layers — the test's PTY wrapping the CLI, and the holder's PTY wrapping the child. This is correct but means output is double-processed through ConPTY on Windows. In practice this works fine (VS Code's integrated terminal does the same).

### Fallback for CI flakiness

If PTY-wrapped attach tests prove flaky in CI (timing, ConPTY batching), gate them behind an environment variable:

```typescript
const HAS_PTY = process.env['HOLDPTY_E2E_ATTACH'] !== '0';
(HAS_PTY ? it : it.skip)('attach and detach', async () => { ... });
```

Default on, but escapable. Better than skipping entirely.

## 3. ConPTY Output Handling

### The problem in detail

On Windows, a child process writing `"hello"` to stdout produces something like:

```
\x1b]0;node\x07\x1b[?25l\x1b[1;1Hhello\r\n\x1b[?25h
```

On Linux, the same child through a PTY produces roughly:

```
hello\r\n
```

The ring buffer stores raw bytes. `logs` dumps them verbatim. You **cannot** assert exact output.

### Recommended approach: Marker-based assertions with flexible matching

**Rule 1: Never assert on exact output. Always use `includes()` or regex.**

**Rule 2: Use unique markers in child commands.** Generate a random token per test and embed it:

```typescript
const marker = `holdpty-test-${randomHex(8)}`;
const session = await launchBg(`echo ${marker}; sleep 10`, testDir);
const output = await runLogs(session, testDir);
expect(output).toContain(marker);
```

This is immune to escape sequences, window titles, prompt strings, and anything else the PTY injects. The marker is a random string that can only appear if the child produced it.

**Rule 3: For structured output (JSON), use the CLI's own structured flags.** `ls --json` and `info` output JSON to stdout. Parse it. If JSON parsing fails, the test fails with a clear error. Don't regex JSON.

```typescript
const raw = await runCli(['ls', '--json'], testDir);
const sessions = JSON.parse(raw.stdout);
expect(sessions).toBeInstanceOf(Array);
expect(sessions[0]).toHaveProperty('name');
```

**Rule 4: For exit codes, don't parse output at all.** Just check `process.exitCode`.

**What NOT to do:**
- Don't build an ANSI stripper. It's a rabbit hole (incomplete VT100 parsing, OSC sequences, ConPTY-specific quirks). You'll spend more time maintaining the stripper than writing tests.
- Don't snapshot PTY output. It changes across node-pty versions, Windows builds, and terminal settings.

## 4. Test Helpers and Patterns

### Core helper: `runCli`

Spawn the CLI as a child process, capture stdout/stderr, return when it exits:

```typescript
interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(
  args: string[],
  opts?: { env?: Record<string, string>; timeout?: number; stdin?: string }
): Promise<CliResult> {
  // spawn('node', ['dist/cli.js', ...args])
  // Set HOLDPTY_DIR from test context
  // Collect stdout/stderr as strings
  // Reject on timeout (default: 10s)
  // Return { stdout, stderr, exitCode }
}
```

This is the workhorse. Every non-interactive test uses it.

### Convenience helper: `launchBg`

```typescript
async function launchBg(
  command: string[],
  opts?: { name?: string }
): Promise<string> {
  const nameArgs = opts?.name ? ['--name', opts.name] : [];
  const result = await runCli(['launch', '--bg', ...nameArgs, '--', ...command]);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim(); // session name
}
```

### Polling helper: `waitForCondition`

```typescript
async function waitForCondition(
  fn: () => Promise<boolean> | boolean,
  opts?: { timeout?: number; interval?: number; label?: string }
): Promise<void> {
  const timeout = opts?.timeout ?? 5000;
  const interval = opts?.interval ?? 100;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await new Promise(r => setTimeout(r, interval));
  }
  throw new Error(`Timed out waiting for: ${opts?.label ?? 'condition'}`);
}
```

### Polling helper: `waitForLogs`

The most important helper. PTY output is async — the child writes, ConPTY processes, ring buffer stores. `logs` reads the buffer at one point in time. You must poll:

```typescript
async function waitForLogs(
  sessionName: string,
  match: string | RegExp,
  opts?: { timeout?: number }
): Promise<string> {
  const timeout = opts?.timeout ?? 5000;
  const deadline = Date.now() + timeout;
  let lastOutput = '';
  while (Date.now() < deadline) {
    const result = await runCli(['logs', sessionName]);
    lastOutput = result.stdout;
    if (typeof match === 'string' ? lastOutput.includes(match) : match.test(lastOutput)) {
      return lastOutput;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(
    `Timed out waiting for logs to contain ${match}.\nLast output:\n${lastOutput}`
  );
}
```

### Test isolation: `TestContext`

Each test gets its own `HOLDPTY_DIR` and tracks spawned processes for cleanup:

```typescript
class TestContext {
  readonly dir: string;
  readonly pids: Set<number> = new Set();
  readonly env: Record<string, string>;

  constructor() {
    this.dir = join(tmpdir(), `holdpty-e2e-${process.pid}-${randomHex(4)}`);
    mkdirSync(this.dir, { recursive: true });
    this.env = { HOLDPTY_DIR: this.dir };
  }

  // Track PIDs from metadata files after launch
  async trackPids(): Promise<void> {
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const meta = JSON.parse(readFileSync(join(this.dir, f), 'utf-8'));
      if (meta.pid) this.pids.add(meta.pid);
      if (meta.childPid) this.pids.add(meta.childPid);
    }
  }

  async cleanup(): Promise<void> {
    // Kill all tracked processes
    for (const pid of this.pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    // Wait briefly for sockets to release (Windows locks)
    await new Promise(r => setTimeout(r, 500));
    // Remove directory
    rmSync(this.dir, { recursive: true, force: true });
  }
}
```

### Critical pattern: Timeout on EVERYTHING

The vision doc correctly identifies this. Every `await` must have a timeout. The `runCli` helper needs one, polling helpers need one, and the vitest test itself needs one:

```typescript
it('lifecycle', async () => { ... }, 30_000); // per-test timeout
```

### The linger problem

The Holder has a **5-second linger** after child exit (`shutdown()` in holder.ts, line ~200). This means:
- After `stop`, the session metadata isn't removed for 5 seconds.
- After `launch --fg` child exits, the process doesn't exit for 5 seconds.
- E2E tests that exercise stop→ls or fg→exit will be slow.

**Recommendation**: Add a `HOLDPTY_LINGER_MS` env var (default 5000, set to 0 in tests). This is a one-line change in `holder.ts` and saves ~5s per lifecycle test. Without this, a suite of 10 lifecycle tests takes 50+ seconds just waiting for linger.

For now, the tests can work around it by:
1. Not waiting for metadata cleanup after `stop` — just verify the child PID is dead.
2. Using `waitForCondition(() => ls shows empty)` with a 10s timeout.

But the env var is strongly recommended for test ergonomics.

## 5. Concrete Proposal

### File structure

```
test/
  e2e/
    helpers.ts          ← TestContext, runCli, launchBg, waitForLogs, etc.
    lifecycle.test.ts   ← launch/ls/logs/stop/info/fg — the core path
    view.test.ts        ← view streaming, child exit during view
    attach.test.ts      ← attach via node-pty wrapper (P3, separate)
    errors.test.ts      ← CLI arg validation, missing sessions, etc.
```

Update `vitest.config.ts` (or `package.json`) to include:
```typescript
// vitest.config.ts
export default {
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    testTimeout: 30_000,
  },
};
```

### `test/e2e/helpers.ts` — Full sketch

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { expect } from 'vitest';

const CLI_PATH = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

// ── Test Context ───────────────────────────────────────────────

export class E2EContext {
  readonly dir: string;
  readonly env: Record<string, string>;
  private pids = new Set<number>();

  constructor() {
    this.dir = join(tmpdir(), `holdpty-e2e-${process.pid}-${randomHex(4)}`);
    mkdirSync(this.dir, { recursive: true });
    this.env = { ...process.env, HOLDPTY_DIR: this.dir } as Record<string, string>;
  }

  async cleanup(): Promise<void> {
    this.collectPids();
    for (const pid of this.pids) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
    await sleep(500); // Let Windows release socket handles
    try { rmSync(this.dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  private collectPids(): void {
    try {
      for (const f of readdirSync(this.dir).filter(f => f.endsWith('.json'))) {
        const meta = JSON.parse(readFileSync(join(this.dir, f), 'utf-8'));
        if (meta.pid) this.pids.add(meta.pid);
        if (meta.childPid) this.pids.add(meta.childPid);
      }
    } catch { /* dir may be gone */ }
  }
}

// ── CLI Runner ─────────────────────────────────────────────────

export interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export function runCli(
  ctx: E2EContext,
  args: string[],
  opts?: { timeout?: number }
): Promise<CliResult> {
  const timeout = opts?.timeout ?? 10_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: ctx.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`CLI timed out after ${timeout}ms.\nArgs: ${args.join(' ')}\nStdout: ${stdout}\nStderr: ${stderr}`));
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

// ── Convenience ────────────────────────────────────────────────

export async function launchBg(
  ctx: E2EContext,
  command: string[],
  name?: string,
): Promise<string> {
  const nameArgs = name ? ['--name', name] : [];
  const result = await runCli(ctx, ['launch', '--bg', ...nameArgs, '--', ...command]);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

export async function waitForLogs(
  ctx: E2EContext,
  session: string,
  match: string | RegExp,
  timeout = 5000,
): Promise<string> {
  const deadline = Date.now() + timeout;
  let last = '';
  while (Date.now() < deadline) {
    const r = await runCli(ctx, ['logs', session]);
    last = r.stdout;
    const found = typeof match === 'string' ? last.includes(match) : match.test(last);
    if (found) return last;
    await sleep(150);
  }
  throw new Error(`waitForLogs timed out. Expected: ${match}\nGot:\n${last}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Platform-appropriate long-running command that prints a marker and waits */
export function echoAndSleep(marker: string, seconds = 30): string[] {
  if (process.platform === 'win32') {
    // cmd /c "echo MARKER && timeout /t 30 /nobreak >nul"
    return ['cmd', '/c', `echo ${marker} && timeout /t ${seconds} /nobreak >nul`];
  }
  return ['sh', '-c', `echo ${marker}; sleep ${seconds}`];
}

/** Platform-appropriate command that exits with a specific code */
export function exitWith(code: number): string[] {
  if (process.platform === 'win32') {
    return ['cmd', '/c', `exit /b ${code}`];
  }
  return ['sh', '-c', `exit ${code}`];
}
```

### Example test cases

#### `test/e2e/lifecycle.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  E2EContext, runCli, launchBg, waitForLogs,
  sleep, echoAndSleep, exitWith,
} from './helpers.js';

let ctx: E2EContext;
beforeEach(() => { ctx = new E2EContext(); });
afterEach(async () => { await ctx.cleanup(); });

describe('launch --bg → ls → logs → stop lifecycle', () => {
  it('launches a background session, lists it, reads logs, stops it', async () => {
    const marker = `test-${Date.now()}`;
    const name = await launchBg(ctx, echoAndSleep(marker), 'lifecycle');

    // stdout is the session name
    expect(name).toBe('lifecycle');

    // ls shows the session
    const ls = await runCli(ctx, ['ls', '--json']);
    const sessions = JSON.parse(ls.stdout);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].name).toBe('lifecycle');

    // logs contain the marker (poll because PTY is async)
    await waitForLogs(ctx, 'lifecycle', marker);

    // stop the session
    const stop = await runCli(ctx, ['stop', 'lifecycle']);
    expect(stop.exitCode).toBe(0);
    expect(stop.stderr).toContain('SIGTERM');

    // ls is eventually empty (after holder linger timeout)
    // Don't wait for linger — just verify child is dead
    await sleep(500);
  }, 20_000);
});

describe('launch --fg', () => {
  it('exits with the child exit code', async () => {
    const result = await runCli(ctx, [
      'launch', '--fg', '--', ...exitWith(42),
    ], { timeout: 15_000 });

    expect(result.exitCode).toBe(42);
  }, 20_000);

  it('prints session name to stdout before blocking', async () => {
    const result = await runCli(ctx, [
      'launch', '--fg', '--name', 'fg-test', '--', ...exitWith(0),
    ], { timeout: 15_000 });

    expect(result.stdout.trim()).toContain('fg-test');
    expect(result.exitCode).toBe(0);
  }, 20_000);
});

describe('info', () => {
  it('returns valid JSON with expected fields', async () => {
    await launchBg(ctx, echoAndSleep('x'), 'info-test');

    const result = await runCli(ctx, ['info', 'info-test']);
    expect(result.exitCode).toBe(0);

    const info = JSON.parse(result.stdout);
    expect(info.name).toBe('info-test');
    expect(info.active).toBe(true);
    expect(info).toHaveProperty('pid');
    expect(info).toHaveProperty('childPid');
    expect(info).toHaveProperty('command');
    expect(info).toHaveProperty('cols');
    expect(info).toHaveProperty('rows');
    expect(info).toHaveProperty('startedAt');
  }, 15_000);
});
```

#### `test/e2e/errors.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { E2EContext, runCli } from './helpers.js';

let ctx: E2EContext;
beforeEach(() => { ctx = new E2EContext(); });
afterEach(async () => { await ctx.cleanup(); });

describe('CLI error handling', () => {
  it('launch with no --fg/--bg fails', async () => {
    const r = await runCli(ctx, ['launch', '--', 'echo', 'hi']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('--fg or --bg');
  });

  it('launch with both --fg and --bg fails', async () => {
    const r = await runCli(ctx, ['launch', '--fg', '--bg', '--', 'echo']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('cannot use both');
  });

  it('launch with no command after -- fails', async () => {
    const r = await runCli(ctx, ['launch', '--bg', '--']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('command');
  });

  it('stop nonexistent session fails', async () => {
    const r = await runCli(ctx, ['stop', 'ghost']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('not found');
  });

  it('logs nonexistent session fails', async () => {
    const r = await runCli(ctx, ['logs', 'ghost']);
    expect(r.exitCode).not.toBe(0);
  });

  it('unknown command fails', async () => {
    const r = await runCli(ctx, ['banana']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('Unknown command');
  });

  it('--help exits 0', async () => {
    const r = await runCli(ctx, ['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('holdpty');
  });

  it('--version exits 0', async () => {
    const r = await runCli(ctx, ['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/holdpty v\d/);
  });
});
```

#### `test/e2e/view.test.ts`

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  E2EContext, runCli, launchBg, waitForLogs,
  sleep, echoAndSleep,
} from './helpers.js';

const CLI_PATH = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

let ctx: E2EContext;
beforeEach(() => { ctx = new E2EContext(); });
afterEach(async () => { await ctx.cleanup(); });

describe('view', () => {
  it('receives live data and exits when child dies', async () => {
    const marker = `view-${Date.now()}`;
    // Launch a session that echoes marker then exits after 2s
    const cmd = process.platform === 'win32'
      ? ['cmd', '/c', `echo ${marker} && timeout /t 2 /nobreak >nul`]
      : ['sh', '-c', `echo ${marker}; sleep 2`];

    await launchBg(ctx, cmd, 'view-test');
    await waitForLogs(ctx, 'view-test', marker); // ensure output is in buffer

    // Start view as a long-running subprocess — collect output until it exits
    const viewOutput = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_PATH, 'view', 'view-test'], {
        env: ctx.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let out = '';
      child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });

      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`view timed out. Output so far:\n${out}`));
      }, 15_000);

      child.on('close', () => {
        clearTimeout(timer);
        resolve(out);
      });
    });

    expect(viewOutput).toContain(marker);
  }, 20_000);
});
```

#### `test/e2e/attach.test.ts` (PTY-wrapped)

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as pty from 'node-pty';
import { join } from 'node:path';
import {
  E2EContext, launchBg, waitForLogs, sleep,
} from './helpers.js';

const CLI_PATH = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

let ctx: E2EContext;
beforeEach(() => { ctx = new E2EContext(); });
afterEach(async () => { await ctx.cleanup(); });

// These tests require a real PTY. They work in CI (GitHub Actions has ConPTY/forkpty)
// but can be skipped with HOLDPTY_E2E_ATTACH=0 if flaky.
const SKIP = process.env['HOLDPTY_E2E_ATTACH'] === '0';

describe('attach (PTY-wrapped)', () => {
  (SKIP ? it.skip : it)('attach, type command, see response, detach', async () => {
    // Launch a shell session
    const shell = process.platform === 'win32' ? ['cmd'] : ['sh'];
    await launchBg(ctx, shell, 'attach-test');
    await sleep(500); // Let shell initialize

    // Attach via a real PTY (so process.stdin.isTTY is true inside the CLI)
    const p = pty.spawn(process.execPath, [CLI_PATH, 'attach', 'attach-test'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env: ctx.env,
    });

    let output = '';
    p.onData(data => { output += data; });

    // Wait for attach to connect
    await sleep(1000);

    // Type a command with a unique marker
    const marker = `e2e-${Date.now()}`;
    p.write(`echo ${marker}\r`);

    // Wait for the marker to appear in output
    const deadline = Date.now() + 10_000;
    while (!output.includes(marker) && Date.now() < deadline) {
      await sleep(100);
    }
    expect(output).toContain(marker);

    // Detach: Ctrl+] then d
    p.write('\x1dd');

    // Wait for the PTY process to exit (detach should cause clean exit)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        p.kill();
        resolve();
      }, 5000);
      p.onExit(() => {
        clearTimeout(timer);
        resolve();
      });
    });

    // The session should still be running (we detached, didn't stop)
    const ls = await import('./helpers.js').then(h => h.runCli(ctx, ['ls', '--json']));
    const sessions = JSON.parse(ls.stdout);
    expect(sessions.some((s: { name: string }) => s.name === 'attach-test')).toBe(true);
  }, 30_000);
});
```

## Summary of Recommendations

| Topic | Recommendation |
|-------|---------------|
| **Priority** | Lead with lifecycle + error tests (cheap, high value). Defer attach to P3. |
| **Attach testing** | Use node-pty from test harness to wrap CLI in a real PTY. Cross-platform, zero new deps. |
| **ConPTY output** | Marker-based assertions with `includes()`. Never exact match. Parse JSON for structured commands. |
| **Isolation** | Unique `HOLDPTY_DIR` per test via `E2EContext`. Track PIDs for cleanup. |
| **Async output** | Poll `logs` in a retry loop with timeout. No fixed `sleep()` for assertions. |
| **Linger timeout** | Add `HOLDPTY_LINGER_MS` env var to holder.ts (one-line change, saves minutes of test time). |
| **File structure** | `test/e2e/` directory, one file per concern, shared helpers. |
| **CI safety** | Timeout on every `await`. `afterEach` kills all tracked PIDs. Attach tests skippable via env var. |
| **What to skip** | Don't re-test what integration tests already cover (multi-view, attach exclusivity, protocol version rejection). |
