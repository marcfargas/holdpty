/**
 * E2E tests: exercise the CLI binary through real shell invocations.
 *
 * These tests spawn `node dist/cli.js` as child processes and verify
 * stdout, stderr, and exit codes. All PTY output uses marker-based
 * assertions (never exact match).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

// ── Constants ──────────────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const CLI_PATH = join(__dirname, "..", "dist", "cli.js");
const NODE = process.execPath;

// ── Helpers ────────────────────────────────────────────────────────

function randomHex(n: number): string {
  return randomBytes(n).toString("hex");
}

function randomMarker(): string {
  return `__HPT_${randomHex(6)}__`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Spawn the CLI binary, capture output, return when it exits.
 */
function runCli(
  args: string[],
  testDir: string,
  opts?: { timeout?: number },
): Promise<CliResult> {
  const timeout = opts?.timeout ?? 15_000;
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI_PATH, ...args], {
      env: {
        ...process.env,
        HOLDPTY_DIR: testDir,
        HOLDPTY_LINGER_MS: "200",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr!.on("data", (d: Buffer) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(
        `CLI timed out after ${timeout}ms\nArgs: ${args.join(" ")}\nStdout: ${stdout}\nStderr: ${stderr}`,
      ));
    }, timeout);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Launch a background session, return the session name.
 */
async function launchBg(
  testDir: string,
  command: string[],
  name?: string,
): Promise<string> {
  const nameArgs = name ? ["--name", name] : [];
  const result = await runCli(
    ["launch", "--bg", ...nameArgs, "--", ...command],
    testDir,
  );
  if (result.exitCode !== 0) {
    throw new Error(`launch --bg failed (code ${result.exitCode}): ${result.stderr}`);
  }
  return result.stdout.trim();
}

/**
 * Poll `logs` until the marker appears in output.
 */
async function waitForOutput(
  testDir: string,
  session: string,
  marker: string,
  timeoutMs = 10_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastOutput = "";
  while (Date.now() < deadline) {
    const result = await runCli(["logs", session], testDir);
    lastOutput = result.stdout;
    if (lastOutput.includes(marker)) return lastOutput;
    await sleep(150);
  }
  throw new Error(
    `waitForOutput timed out after ${timeoutMs}ms.\nExpected: ${marker}\nGot:\n${lastOutput}`,
  );
}

/**
 * Poll until a predicate is true.
 */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
}

/**
 * Force-kill all sessions in a test directory.
 */
function killAllSessions(testDir: string): void {
  try {
    for (const f of readdirSync(testDir).filter((f) => f.endsWith(".json"))) {
      const meta = JSON.parse(readFileSync(join(testDir, f), "utf-8"));
      try { process.kill(meta.pid, "SIGKILL"); } catch { /* dead */ }
      try { process.kill(meta.childPid, "SIGKILL"); } catch { /* dead */ }
    }
  } catch { /* dir may be gone */ }
}

// ── Test setup ─────────────────────────────────────────────────────

let testDir: string;

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "holdpty-e2e-"));
});

afterEach(async () => {
  killAllSessions(testDir);
  await sleep(500); // Let Windows release pipe handles
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best effort */ }
}, 15_000);

// ── CLI basics ─────────────────────────────────────────────────────

describe("cli basics", () => {
  it("--help prints usage and exits 0", async () => {
    const r = await runCli(["--help"], testDir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("holdpty");
    expect(r.stdout).toContain("launch");
    expect(r.stdout).toContain("attach");
    expect(r.stdout).toContain("view");
    expect(r.stdout).toContain("logs");
  });

  it("--version prints version and exits 0", async () => {
    const r = await runCli(["--version"], testDir);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/holdpty v\d+/);
  });

  it("unknown command exits non-zero with error", async () => {
    const r = await runCli(["banana"], testDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("Unknown command");
  });

  it("launch without --fg/--bg exits non-zero", async () => {
    const r = await runCli(["launch", "--", "echo", "hi"], testDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("--fg or --bg");
  });

  it("launch with both --fg and --bg exits non-zero", async () => {
    const r = await runCli(["launch", "--fg", "--bg", "--", "echo"], testDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("cannot use both");
  });

  it("launch with no command after -- exits non-zero", async () => {
    const r = await runCli(["launch", "--bg", "--"], testDir);
    expect(r.exitCode).not.toBe(0);
  });
});

// ── Core lifecycle (monolith) ──────────────────────────────────────

describe("lifecycle", () => {
  it("launch --bg → ls → logs → info → stop → cleanup", async () => {
    const marker = randomMarker();

    // 1. Launch a background session that prints a marker and sleeps
    const sessionName = await launchBg(
      testDir,
      [NODE, "-e", `process.stdout.write("${marker}"); setTimeout(() => {}, 60000)`],
      "lifecycle",
    );
    expect(sessionName).toBe("lifecycle");

    // 2. ls shows the session
    const ls = await runCli(["ls", "--json"], testDir);
    expect(ls.exitCode).toBe(0);
    const sessions = JSON.parse(ls.stdout);
    expect(sessions).toBeInstanceOf(Array);
    expect(sessions.length).toBe(1);
    expect(sessions[0].name).toBe("lifecycle");
    expect(sessions[0].metadata.command).toContain(NODE);

    // 3. logs contain the marker (poll — PTY output is async)
    const output = await waitForOutput(testDir, "lifecycle", marker);
    expect(output).toContain(marker);

    // 4. info returns valid JSON with expected fields
    const info = await runCli(["info", "lifecycle"], testDir);
    expect(info.exitCode).toBe(0);
    const meta = JSON.parse(info.stdout);
    expect(meta.name).toBe("lifecycle");
    expect(meta.active).toBe(true);
    expect(typeof meta.pid).toBe("number");
    expect(typeof meta.childPid).toBe("number");
    expect(meta).toHaveProperty("cols");
    expect(meta).toHaveProperty("rows");
    expect(meta).toHaveProperty("startedAt");

    // 5. stop succeeds
    const stop = await runCli(["stop", "lifecycle"], testDir);
    expect(stop.exitCode).toBe(0);
    expect(stop.stderr).toContain("Stopped session");

    // 6. Eventually ls is empty (holder linger + cleanup)
    await waitUntil(async () => {
      const ls2 = await runCli(["ls", "--json"], testDir);
      try {
        return JSON.parse(ls2.stdout).length === 0;
      } catch {
        return false;
      }
    }, 10_000);
  }, 30_000);
});

// ── launch --bg stdout contract ────────────────────────────────────

describe("launch --bg stdout", () => {
  it("prints exactly the session name to stdout", async () => {
    const r = await runCli(
      ["launch", "--bg", "--name", "stdout-test", "--", NODE, "-e", "setTimeout(()=>{},30000)"],
      testDir,
    );
    expect(r.exitCode).toBe(0);
    // stdout must be exactly the session name + newline (agents parse this)
    expect(r.stdout).toBe("stdout-test\n");
    expect(r.stderr).toBe("");
  });

  it("auto-generates name when --name is omitted", async () => {
    const name = await launchBg(
      testDir,
      [NODE, "-e", "setTimeout(()=>{},30000)"],
    );
    // Auto-name format: basename-xxxx (node-xxxx on this platform)
    expect(name).toMatch(/^node-[a-f0-9]{4}$/);
  });
});

// ── launch --fg ────────────────────────────────────────────────────

describe("launch --fg", () => {
  it("exits with child exit code 0", async () => {
    const r = await runCli(
      ["launch", "--fg", "--", NODE, "-e", "process.exit(0)"],
      testDir,
      { timeout: 20_000 },
    );
    expect(r.exitCode).toBe(0);
  }, 25_000);

  it("exits with child exit code 42", async () => {
    const r = await runCli(
      ["launch", "--fg", "--", NODE, "-e", "process.exit(42)"],
      testDir,
      { timeout: 20_000 },
    );
    expect(r.exitCode).toBe(42);
  }, 25_000);

  it("prints session name as first line of stdout", async () => {
    const r = await runCli(
      ["launch", "--fg", "--name", "fg-name", "--", NODE, "-e", "process.exit(0)"],
      testDir,
      { timeout: 20_000 },
    );
    // PTY may emit terminal init sequences after the session name,
    // so check the first line only (ConPTY emits [?9001h etc.)
    const firstLine = r.stdout.split("\n")[0].trim();
    expect(firstLine).toBe("fg-name");
  }, 25_000);
});

// ── Error cases ────────────────────────────────────────────────────

describe("error handling", () => {
  it("stop nonexistent session exits non-zero", async () => {
    const r = await runCli(["stop", "ghost"], testDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not found");
  });

  it("logs nonexistent session exits non-zero", async () => {
    const r = await runCli(["logs", "ghost"], testDir);
    expect(r.exitCode).not.toBe(0);
  });

  it("info nonexistent session exits non-zero", async () => {
    const r = await runCli(["info", "ghost"], testDir);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain("not found");
  });
});

// ── view ───────────────────────────────────────────────────────────

describe("view", () => {
  it("receives replay and live data", async () => {
    const marker1 = randomMarker();
    const marker2 = randomMarker();

    // Launch: print marker1 immediately, marker2 after 500ms, then wait
    await launchBg(
      testDir,
      [NODE, "-e", `
        process.stdout.write("${marker1}");
        setTimeout(() => process.stdout.write("${marker2}"), 500);
        setTimeout(() => {}, 60000);
      `],
      "viewtest",
    );

    // Wait for marker1 to appear in the ring buffer
    await waitForOutput(testDir, "viewtest", marker1);

    // Spawn view as a subprocess, collect output for 2s, then kill
    const viewOutput = await new Promise<string>((resolve, reject) => {
      const child = spawn(NODE, [CLI_PATH, "view", "viewtest"], {
        env: { ...process.env, HOLDPTY_DIR: testDir, HOLDPTY_LINGER_MS: "200" },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout!.on("data", (d: Buffer) => { stdout += d.toString(); });

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(stdout);
      }, 3000);

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    // Should have marker1 (from replay) and marker2 (from live stream)
    expect(viewOutput).toContain(marker1);
    expect(viewOutput).toContain(marker2);
  }, 20_000);
});
