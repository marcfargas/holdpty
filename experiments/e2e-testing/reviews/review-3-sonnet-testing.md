Now I have full context. Here's the review:

---

# E2E Testing Vision — Critical Review

## 1. Testing Strategy: Priority Ranking Assessment

### What's correct

The P1 list correctly identifies the **launch → ls → logs → stop lifecycle** as the core flow. This is the single most important thing to test because it's what every user and agent will do first. `ls --json` is also correctly P1 — agents will parse this programmatically.

### What should change

**Stale session cleanup should be P2, not P1.** It requires killing a holder process externally and verifying auto-cleanup on the next `ls`. That's an important robustness test, but it's an edge case, not a core flow. It also needs platform-specific PID handling (Windows `taskkill` vs `kill`), adding complexity disproportionate to its value for MVP.

**`launch --fg` exit code should be P1 but with a caveat.** The 5-second linger in `holder.ts` `shutdown()` means every `--fg` test that waits for exit pays a 5s+ penalty. You need either: (a) a test-only env var to reduce linger time, or (b) accept that these tests are slow and run few of them. I'd recommend (a) — add `HOLDPTY_LINGER_MS` with a default of 5000, override to 200 in tests.

**Error cases are missing from all priority tiers.** You should add to P1:
- `launch` with no `--fg`/`--bg` → non-zero exit + error on stderr
- `launch` with no `--` → non-zero exit + error on stderr
- `stop <nonexistent>` → non-zero exit
- `logs <nonexistent>` → non-zero exit

These are critical for agent consumers who parse exit codes. They cost almost nothing to write and catch regressions in the arg-parsing logic in `cli.ts`.

**`--help` and `--version` should be P1.** Trivial to test (spawn, check stdout, check exit 0). They validate that the binary runs at all. Good as a canary test that runs first.

### What's over-scoped

**P3 items (resize propagation, attach exclusivity at CLI level) are correctly deferred.** Attach exclusivity is already tested at the library level. Resize requires a real TTY. Don't invest here for MVP.

**Multiple simultaneous viewers (P2) is already tested in integration.test.ts.** The CLI `view` command is a thin wrapper. Unless you suspect the CLI adds a bug, demote this to P3 or drop it.

### What's missing entirely

1. **`info <session>` output validation** — the vision mentions it in P1 but it's easy to overlook. It should return valid JSON with `active: true` for a running session.

2. **Session name collision** — `launch --bg --name foo` twice should fail on the second invocation (or at least not corrupt state). Quick P2 test.

3. **`launch --bg` stdout contract** — the session name printed to stdout must be *exactly* the name, with a trailing newline, no other output. Agents will do `SESSION=$(holdpty launch --bg -- cmd)`. This is P1 and easy to assert.

4. **Signal handling / stop actually terminates** — `stop` sends SIGTERM to `childPid`. You should verify the session actually goes away after `stop` (poll `ls` until empty). Currently the vision says "session disappears from `ls`" but there's a timing gap — the holder needs to receive the signal, run shutdown, linger, and clean up. On Windows, `process.kill(pid, 'SIGTERM')` doesn't send SIGTERM — it terminates the process. This platform difference should be tested.

## 2. The Attach Problem

### Evaluation of options in the vision

| Option | Verdict |
|--------|---------|
| **Skip in CI, manual-only** | Acceptable for MVP. Honest about the constraint. |
| **Use holdpty itself to create PTY** | Circular dependency. If holdpty is broken, the test harness is broken. Reject. |
| **Monkey-patch `isTTY`** | Doesn't work. Raw mode requires a real TTY fd. `setRawMode(true)` will throw on a pipe even if `isTTY` is patched. |
| **Use `script` (Linux) / `winpty` (Windows)** | Viable but fragile. `script` varies between GNU/BSD. `winpty` is a separate dependency. CI maintenance burden. |
| **Test at library level only** | This is what you already have. Sufficient for MVP. |

### Concrete recommendation

**For MVP: Don't test attach at the CLI level. The library-level tests are sufficient.**

Here's why: `cmdAttach` in `cli.ts` is 4 lines — it calls `attach({ name })` and exits with the code. The complex logic (raw mode, detach detection, data forwarding) is in `client.ts attach()`, which is already exercised by the integration tests via `connect({ mode: 'attach' })`.

The one thing the integration tests *don't* cover is the raw-mode stdin/detach sequence. But that's exactly the thing you can't test without a real TTY.

**For post-MVP**, if you want to add attach tests:

Use **node-pty as a test harness** — not holdpty itself, but node-pty directly. Create a PTY in the test, run `node dist/cli.js attach <session>` inside it, write bytes to the PTY's stdin, read from its stdout. This gives you a real TTY for the attach command to detect.

```typescript
// Conceptual approach — NOT circular because we use node-pty as a test tool,
// not holdpty. node-pty is a devDependency anyway.
import * as pty from "node-pty";

function spawnInPty(cmd: string, args: string[]): pty.IPty {
  return pty.spawn(cmd, args, {
    name: "xterm-256color",
    cols: 80,
    rows: 24,
    env: { ...process.env, HOLDPTY_DIR: testDir },
  });
}

// In a test:
const attachPty = spawnInPty(process.execPath, [cliPath, "attach", sessionName]);
// attachPty.write("echo hello\r");
// collect output, look for "hello"
// attachPty.write("\x1dd"); // Ctrl+] then d → detach
// wait for exit
```

This is NOT circular — it's using node-pty as a test utility (like Playwright uses Chrome to test web apps, not itself). The attach code runs inside a real PTY, gets `isTTY=true`, enters raw mode. You write bytes to the PTY, the attach command forwards them to the held session. This works in CI because node-pty creates its own PTY pair — it doesn't need the parent process to have a TTY.

**I'd add this as a single focused test in a later phase**, not MVP.

## 3. ConPTY Output Handling

### The problem, concretely

When you run `node -e "process.stdout.write('hello')"` inside a ConPTY on Windows, the captured output is NOT just `hello`. It includes:
- Window title escape sequences (`\x1b]0;...\x07`)
- Cursor positioning (`\x1b[?25h`, `\x1b[H`)
- Line clearing (`\x1b[2J`)
- The prompt if running a shell
- Line endings as `\r\n` not `\n`

On Linux with forkpty, the output is much cleaner but still includes `\r\n` line endings (PTY convention).

### Recommended approach: Markers + contains + strip

**Use a three-layer strategy:**

**Layer 1: Marker strings.** Embed unique, greppable markers in the child command's output. Don't assert on `hello` — assert on `___HOLDPTY_TEST_abc123___`. No ConPTY noise will accidentally produce that.

```typescript
const MARKER = `__HPT_${randomHex(8)}__`;
const cmd = [process.execPath, "-e", `process.stdout.write("${MARKER}")`];
// Later: expect(output).toContain(MARKER);
```

**Layer 2: ANSI stripping utility.** For cases where you need to assert on structure (e.g., `ls` table output, `info` JSON), strip escape sequences:

```typescript
function stripAnsi(s: string): string {
  // Covers CSI sequences, OSC sequences, and single-byte C1 controls
  return s.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[>=<]|\x1b\[[\?]?[0-9;]*[hl]/g, "");
}
```

**Layer 3: JSON parsing.** For `ls --json` and `info`, parse the stdout as JSON. If ConPTY noise leaks in, `JSON.parse()` will fail — which is itself a useful assertion (it means the stdout discipline is broken). Since `ls` and `info` write to stdout directly (not through a PTY), they should be clean. If they're not, that's a bug.

**Do NOT attempt exact output matching for PTY-relayed data.** Ever. On any platform. `includes()` and marker strings are the way.

## 4. Test Helpers and Patterns

### Core helper: `runCli`

The most important helper. Spawns the CLI binary, captures stdout/stderr, returns exit code + output.

```typescript
import { spawn } from "node:child_process";

const CLI_PATH = resolve(__dirname, "../dist/cli.js");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts?: { timeout?: number; env?: Record<string, string> }): Promise<CliResult> {
  const timeout = opts?.timeout ?? 15_000;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: { ...process.env, HOLDPTY_DIR: testDir, ...opts?.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });

    child.on("error", reject);
  });
}
```

### Core helper: `launchBg`

Wraps `launch --bg`, waits for session to be ready, returns session name. Returns a cleanup handle.

```typescript
interface BgSession {
  name: string;
  cleanup: () => Promise<void>;
}

async function launchBg(command: string[], name?: string): Promise<BgSession> {
  const args = ["launch", "--bg"];
  if (name) args.push("--name", name);
  args.push("--", ...command);

  const result = await runCli(args);
  if (result.code !== 0) {
    throw new Error(`launch --bg failed: ${result.stderr}`);
  }

  const sessionName = result.stdout.trim();

  return {
    name: sessionName,
    cleanup: async () => {
      // Try graceful stop, then force-kill
      await runCli(["stop", sessionName]).catch(() => {});
      // Wait for holder to exit (linger period)
      await waitUntil(async () => {
        const ls = await runCli(["ls", "--json"]);
        const sessions = JSON.parse(ls.stdout);
        return !sessions.some((s: any) => s.name === sessionName);
      }, 10_000);
    },
  };
}
```

### Core helper: `waitUntil` (polling with timeout)

Essential. Replaces all `sleep()` calls with deterministic waiting.

```typescript
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number = 10_000,
  intervalMs: number = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}
```

### Core helper: `waitForOutput` (poll logs until marker appears)

```typescript
async function waitForOutput(sessionName: string, marker: string, timeoutMs = 10_000): Promise<string> {
  let lastOutput = "";
  await waitUntil(async () => {
    const result = await runCli(["logs", sessionName]);
    lastOutput = result.stdout;
    return lastOutput.includes(marker);
  }, timeoutMs);
  return lastOutput;
}
```

### Cleanup pattern

**Every test gets an isolated `HOLDPTY_DIR` and tracks sessions for cleanup.** The `afterEach` is aggressive — it kills any holder processes that survived.

```typescript
import { mkdtempSync, rmSync } from "node:fs";

let testDir: string;
const sessions: BgSession[] = [];

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "holdpty-e2e-"));
});

afterEach(async () => {
  // Stop all tracked sessions
  for (const s of sessions) {
    await s.cleanup().catch(() => {});
  }
  sessions.length = 0;

  // Nuclear cleanup: kill any holdpty processes in this test dir
  // (Not strictly necessary if cleanup works, but CI safety net)
  await new Promise((r) => setTimeout(r, 500));

  // Remove test dir
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
}, 30_000); // generous afterEach timeout
```

### Important: the linger problem

The 5-second linger in `Holder.shutdown()` is a real problem for E2E tests. Every test that involves child exit or `stop` pays a 5+ second penalty. With 15 tests, that's >75 seconds of pure waiting.

**Recommendation: Add `HOLDPTY_LINGER_MS` env var.** In `holder.ts`, replace the hardcoded `5000` with:

```typescript
const lingerMs = parseInt(process.env["HOLDPTY_LINGER_MS"] ?? "5000", 10);
```

In E2E tests, set `HOLDPTY_LINGER_MS=200`. This is a legitimate configuration knob — users running many short-lived sessions would also benefit from it. Document it as advanced/internal.

Without this, you'll either have painfully slow tests or you'll resort to force-killing holder processes (which defeats the purpose of testing the lifecycle).

## 5. Concrete Proposal

### File structure

```
src/
  e2e/
    e2e.test.ts          # All E2E tests
    helpers.ts            # runCli, launchBg, waitUntil, waitForOutput, stripAnsi, cleanup
```

Separate directory, but still under `src/` so Vitest picks it up with the existing config. A dedicated subdirectory keeps E2E tests visually separate from unit/integration tests.

In `vitest.config.ts` or `package.json`, optionally add a script:
```json
"test:e2e": "vitest run src/e2e/"
```

### helpers.ts

```typescript
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
export const CLI_PATH = resolve(__dirname, "../../dist/cli.js");

// ── Types ──────────────────────────────────────────────────────

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface BgSession {
  name: string;
  cleanup: () => Promise<void>;
}

// ── Test directory ─────────────────────────────────────────────

export function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), "holdpty-e2e-"));
}

export function removeTestDir(dir: string): void {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ── CLI runner ─────────────────────────────────────────────────

export function runCli(
  args: string[],
  testDir: string,
  opts?: { timeout?: number; stdin?: string },
): Promise<CliResult> {
  const timeout = opts?.timeout ?? 15_000;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOLDPTY_DIR: testDir,
        HOLDPTY_LINGER_MS: "200",  // fast cleanup for tests
      },
      stdio: [opts?.stdin ? "pipe" : "ignore", "pipe", "pipe"],
      timeout,
    });

    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

// ── High-level helpers ─────────────────────────────────────────

export async function launchBg(
  testDir: string,
  command: string[],
  name?: string,
): Promise<BgSession> {
  const args = ["launch", "--bg"];
  if (name) args.push("--name", name);
  args.push("--", ...command);

  const result = await runCli(args, testDir);
  if (result.code !== 0) {
    throw new Error(`launch --bg failed (code ${result.code}): ${result.stderr}`);
  }
  const sessionName = result.stdout.trim();

  return {
    name: sessionName,
    cleanup: async () => {
      await runCli(["stop", sessionName], testDir).catch(() => {});
      await waitUntil(async () => {
        const ls = await runCli(["ls", "--json"], testDir);
        try {
          const sessions = JSON.parse(ls.stdout);
          return !sessions.some((s: { name: string }) => s.name === sessionName);
        } catch {
          return true; // parse failure = no sessions
        }
      }, 10_000).catch(() => {});
    },
  };
}

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

export async function waitForOutput(
  testDir: string,
  sessionName: string,
  marker: string,
  timeoutMs = 10_000,
): Promise<string> {
  let lastOutput = "";
  await waitUntil(async () => {
    const result = await runCli(["logs", sessionName], testDir);
    lastOutput = result.stdout;
    return lastOutput.includes(marker);
  }, timeoutMs);
  return lastOutput;
}

export function stripAnsi(s: string): string {
  return s.replace(
    /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[>=<]|\x1b\[\?[0-9;]*[hl]/g,
    "",
  );
}

export function randomMarker(): string {
  const hex = Math.random().toString(16).slice(2, 10);
  return `__HPT_${hex}__`;
}
```

### e2e.test.ts — Example test cases

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  runCli, launchBg, waitForOutput, waitUntil, randomMarker,
  createTestDir, removeTestDir, type BgSession,
} from "./helpers.js";

let testDir: string;
const sessions: BgSession[] = [];

beforeEach(() => {
  testDir = createTestDir();
});

afterEach(async () => {
  for (const s of sessions) {
    await s.cleanup().catch(() => {});
  }
  sessions.length = 0;
  await new Promise((r) => setTimeout(r, 300));
  removeTestDir(testDir);
}, 30_000);

// ── Canary tests ───────────────────────────────────────────────

describe("cli basics", () => {
  it("--help prints usage and exits 0", async () => {
    const result = await runCli(["--help"], testDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("holdpty");
    expect(result.stdout).toContain("launch");
    expect(result.stdout).toContain("attach");
  });

  it("--version prints version and exits 0", async () => {
    const result = await runCli(["--version"], testDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/holdpty v\d+/);
  });

  it("unknown command exits non-zero", async () => {
    const result = await runCli(["bogus"], testDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Unknown command");
  });

  it("launch without --fg/--bg exits non-zero", async () => {
    const result = await runCli(["launch", "--", "echo", "hi"], testDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("--fg or --bg");
  });
});

// ── Core lifecycle ─────────────────────────────────────────────

describe("launch --bg → ls → logs → stop lifecycle", () => {
  it("full lifecycle works end to end", async () => {
    const marker = randomMarker();
    // 1. Launch a background session that prints a marker and sleeps
    const session = await launchBg(testDir, [
      process.execPath, "-e",
      `process.stdout.write("${marker}"); setTimeout(() => {}, 30000)`,
    ], "lifecycle");
    sessions.push(session);

    // Session name should be exactly what we asked for
    expect(session.name).toBe("lifecycle");

    // 2. ls should show the session
    const ls = await runCli(["ls", "--json"], testDir);
    expect(ls.code).toBe(0);
    const list = JSON.parse(ls.stdout);
    expect(list).toBeInstanceOf(Array);
    const entry = list.find((s: { name: string }) => s.name === "lifecycle");
    expect(entry).toBeDefined();
    expect(entry.metadata.command).toContain(process.execPath);

    // 3. logs should contain the marker (poll until available)
    const output = await waitForOutput(testDir, "lifecycle", marker);
    expect(output).toContain(marker);

    // 4. info should return valid JSON
    const info = await runCli(["info", "lifecycle"], testDir);
    expect(info.code).toBe(0);
    const meta = JSON.parse(info.stdout);
    expect(meta.name).toBe("lifecycle");
    expect(meta.active).toBe(true);
    expect(typeof meta.pid).toBe("number");

    // 5. stop should succeed
    const stop = await runCli(["stop", "lifecycle"], testDir);
    expect(stop.code).toBe(0);
    expect(stop.stderr).toContain("SIGTERM");

    // 6. After stop + cleanup, ls should be empty
    await waitUntil(async () => {
      const ls2 = await runCli(["ls", "--json"], testDir);
      try {
        const sessions = JSON.parse(ls2.stdout);
        return sessions.length === 0;
      } catch {
        return false;
      }
    }, 10_000);
  }, 30_000);
});

// ── launch --fg ────────────────────────────────────────────────

describe("launch --fg", () => {
  it("exits with child exit code", async () => {
    const result = await runCli(
      ["launch", "--fg", "--", process.execPath, "-e", "process.exit(42)"],
      testDir,
      { timeout: 20_000 },
    );
    expect(result.code).toBe(42);
  }, 25_000); // 5s linger (or 200ms with HOLDPTY_LINGER_MS)

  it("captures child stdout in logs before exit", async () => {
    const marker = randomMarker();
    const result = await runCli(
      ["launch", "--fg", "--name", "fgtest", "--",
       process.execPath, "-e",
       `process.stdout.write("${marker}"); process.exit(0)`],
      testDir,
      { timeout: 20_000 },
    );
    expect(result.code).toBe(0);
    // stdout of --fg is the session name, NOT the child output
    // (child output goes to the PTY → ring buffer → clients)
    expect(result.stdout.trim()).toBe("fgtest");
  }, 25_000);
});

// ── Error cases ────────────────────────────────────────────────

describe("error handling", () => {
  it("logs nonexistent session exits non-zero", async () => {
    const result = await runCli(["logs", "no-such-session"], testDir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("not found");
  });

  it("stop nonexistent session exits non-zero", async () => {
    const result = await runCli(["stop", "no-such-session"], testDir);
    expect(result.code).not.toBe(0);
  });

  it("info nonexistent session exits non-zero", async () => {
    const result = await runCli(["info", "no-such-session"], testDir);
    expect(result.code).not.toBe(0);
  });
});

// ── view (live streaming) ──────────────────────────────────────

describe("view", () => {
  it("receives live data from session", async () => {
    // Launch a session that prints markers at intervals
    const marker1 = randomMarker();
    const marker2 = randomMarker();
    const session = await launchBg(testDir, [
      process.execPath, "-e", `
        process.stdout.write("${marker1}");
        setTimeout(() => { process.stdout.write("${marker2}"); }, 500);
        setTimeout(() => {}, 30000);
      `,
    ], "viewtest");
    sessions.push(session);

    // Wait for first marker to be in the buffer
    await waitForOutput(testDir, "viewtest", marker1);

    // Spawn view as a child process, collect output for 2s, then kill
    const viewOutput = await new Promise<string>((resolve, reject) => {
      const { spawn } = require("node:child_process");
      const child = spawn(
        process.execPath,
        [CLI_PATH, "view", "viewtest"],
        {
          env: { ...process.env, HOLDPTY_DIR: testDir },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );

      let stdout = "";
      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });

      // Give it time to receive replay + live data
      setTimeout(() => {
        child.kill();
        resolve(stdout);
      }, 2000);

      child.on("error", reject);
    });

    // Should contain both markers (first from replay, second from live)
    expect(viewOutput).toContain(marker1);
    expect(viewOutput).toContain(marker2);
  }, 20_000);
});
```

### Key design decisions in this proposal

1. **One big lifecycle test, not many small ones.** The `launch → ls → logs → info → stop → ls` chain is one logical flow. Splitting it into 6 tests means 6× the launch+teardown overhead. A single test with clear step comments and labeled assertions (`// 3. logs should contain the marker`) is faster and just as debuggable. Vitest shows which `expect()` failed with line numbers.

2. **Markers everywhere.** Every child command embeds a unique random marker. This makes ConPTY noise irrelevant. No ANSI stripping needed for the core flow.

3. **`waitForOutput` as the primary synchronization primitive.** No `sleep(500)`. Poll `logs` until the marker appears. This adapts to CI speed automatically — fast on a fast runner, patient on a slow one.

4. **`view` test uses a time-bounded spawn.** You can't use `runCli` for `view` because it never exits (it streams until the session ends). Instead, spawn the process, collect output for N seconds, kill it. This is robust because you check for markers, not timing.

5. **Tests are independent.** Each `beforeEach` creates a fresh `HOLDPTY_DIR`. No cross-test pollution. Named pipes on Windows include the session name (not the dir), so you need unique session names across tests if they run in parallel — but Vitest runs tests in a single file sequentially by default, so this is fine.

### Critical prerequisite: `HOLDPTY_LINGER_MS`

I want to emphasize this again: **without a configurable linger time, the E2E suite will be painfully slow.** Every test touching `stop` or `--fg` with child exit pays a 5-second penalty. The `HOLDPTY_LINGER_MS` change is ~3 lines in `holder.ts` and it transforms the suite from "90 seconds" to "15 seconds."

```typescript
// In holder.ts shutdown():
const lingerMs = Math.max(0, parseInt(process.env["HOLDPTY_LINGER_MS"] ?? "5000", 10)) || 5000;
setTimeout(() => {
  // ... cleanup ...
}, lingerMs);
```

### Summary of recommended test count

| Category | Tests | Priority |
|----------|-------|----------|
| CLI basics (help, version, bad args) | 4 | P1 |
| Full lifecycle (launch→ls→logs→info→stop) | 1 | P1 |
| launch --fg exit code | 1-2 | P1 |
| Error cases (nonexistent session) | 3 | P1 |
| launch --bg stdout contract | 1 | P1 |
| view live streaming | 1 | P2 |
| auto-generated session name | 1 | P2 |
| **Total MVP** | **~13** | |

That's lean, fast, and covers the real-user surface. Ship it, then expand.
