#!/usr/bin/env node

/**
 * holdpty CLI entry point.
 *
 * Minimal argument parsing — no framework needed for 8 commands.
 */

import { Holder } from "./holder.js";
import { attach, view, logs } from "./client.js";
import { listSessions, readMetadata, removeSession, isSessionActive } from "./session.js";
import { getSessionDir } from "./platform.js";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// Read version from package.json at build time — keep in sync
const VERSION = "0.1.0";

// ── Argument parsing ───────────────────────────────────────────────

function usage(): string {
  return `holdpty v${VERSION} — Minimal cross-platform detached PTY

Usage:
  holdpty launch --bg|--fg [--name <name>] [--] <command> [args...]
  holdpty attach <session>
  holdpty view <session>
  holdpty logs <session> [--tail N] [--follow] [--no-replay]
  holdpty ls [--json]
  holdpty stop <session>
  holdpty info <session>
  holdpty --help | --version`;
}

function die(msg: string): never {
  process.stderr.write(`Error: ${msg}\n`);
  process.exit(1);
}

// ── Commands ───────────────────────────────────────────────────────

async function cmdLaunch(args: string[]): Promise<void> {
  let fg = false;
  let bg = false;
  let name: string | undefined;
  let cmdStart = -1;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--fg") {
      fg = true;
    } else if (arg === "--bg") {
      bg = true;
    } else if (arg === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (arg === "--") {
      cmdStart = i + 1;
      break;
    } else if (arg.startsWith("-")) {
      die(`Unknown launch option: ${arg}`);
    } else {
      // Non-flag argument: treat as command start (-- is optional).
      // PowerShell strips bare `--` before it reaches process.argv,
      // so we must support: holdpty launch --bg sleep 30
      cmdStart = i;
      break;
    }
  }

  if (!fg && !bg) die("launch requires --fg or --bg");
  if (fg && bg) die("launch cannot use both --fg and --bg");
  if (cmdStart < 0 || cmdStart >= args.length) die("launch requires a command after the flags");

  const command = args.slice(cmdStart);
  if (command.length === 0) die("launch requires a command");

  if (bg) {
    // Spawn the holder as a detached child process.
    // Use a ready-file to signal that the holder has started.
    const thisFile = fileURLToPath(import.meta.url);
    const readyFile = resolve(
      getSessionDir(),
      `.ready-${process.pid}-${Date.now()}`,
    );

    const child = spawn(
      process.execPath,
      [
        thisFile, "__holder",
        ...(name ? ["--name", name] : []),
        "--ready-file", readyFile,
        "--", ...command,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();

    // Poll for the ready file (contains the session name)
    const deadline = Date.now() + 5000;
    let sessionName = "";
    while (Date.now() < deadline) {
      try {
        sessionName = readFileSync(readyFile, "utf-8").trim();
        unlinkSync(readyFile);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    if (!sessionName) {
      die("Holder did not start within 5s");
    }

    process.stdout.write(sessionName + "\n");
  } else {
    // Foreground: run holder in this process, bridge stdin/stdout to PTY
    const holder = await Holder.start({ command, name });
    process.stdout.write(holder.sessionName + "\n");
    const code = await holder.pipeStdio();
    process.exit(code);
  }
}

/**
 * Internal command: run the holder process (used by --bg launch).
 */
async function cmdHolder(args: string[]): Promise<void> {
  let name: string | undefined;
  let readyFile: string | undefined;
  let cmdStart = -1;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (args[i] === "--ready-file" && i + 1 < args.length) {
      readyFile = args[++i];
    } else if (args[i] === "--") {
      cmdStart = i + 1;
      break;
    }
  }

  if (cmdStart < 0) die("__holder requires -- <command>");
  const command = args.slice(cmdStart);

  const holder = await Holder.start({ command, name });

  // Signal the parent that we're ready by writing session name to the ready file
  if (readyFile) {
    writeFileSync(readyFile, holder.sessionName, "utf-8");
  }

  // Keep running until child exits
  await holder.waitForExit();
}

async function cmdAttach(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) die("attach requires a session name");

  const code = await attach({ name });
  if (code !== null) {
    process.exit(code);
  }
  // code === null means detached
}

async function cmdView(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) die("view requires a session name");
  await view({ name });
}

async function cmdLogs(args: string[]): Promise<void> {
  let name: string | undefined;
  let tail: number | undefined;
  let follow = false;
  let noReplay = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--tail" || arg === "-n") {
      const val = args[++i];
      if (val === undefined) die("--tail requires a number");
      tail = parseInt(val, 10);
      if (isNaN(tail) || tail < 1) die("--tail requires a positive integer");
    } else if (arg === "--follow" || arg === "-f") {
      follow = true;
    } else if (arg === "--no-replay") {
      noReplay = true;
    } else if (!arg.startsWith("-")) {
      name = arg;
    } else {
      die(`Unknown logs option: ${arg}`);
    }
  }

  if (!name) die("logs requires a session name");
  if (noReplay && !follow) die("--no-replay requires --follow");
  if (noReplay && tail != null) die("--no-replay and --tail are mutually exclusive");

  await logs({ name, tail, follow, noReplay });
}

async function cmdLs(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const sessions = await listSessions({ clean: true });

  if (json) {
    process.stdout.write(JSON.stringify(sessions, null, 2) + "\n");
    return;
  }

  if (sessions.length === 0) {
    process.stderr.write("No active sessions\n");
    return;
  }

  // Table output
  const header = "NAME            PID     COMMAND                           STARTED";
  process.stdout.write(header + "\n");
  for (const s of sessions) {
    const { name, metadata: m } = s;
    const cmd = m.command.join(" ").slice(0, 35);
    const started = m.startedAt.replace("T", " ").replace(/\.\d+Z$/, "Z");
    process.stdout.write(
      `${name.padEnd(16)}${String(m.childPid).padEnd(8)}${cmd.padEnd(34)}${started}\n`,
    );
  }
}

async function cmdStop(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) die("stop requires a session name");

  const meta = readMetadata(name);
  if (!meta) die(`Session "${name}" not found`);

  if (!isSessionActive(name)) {
    // Clean stale files
    removeSession(name);
    process.stderr.write(`Session "${name}" is not running (cleaned stale files)\n`);
    return;
  }

  try {
    // Kill the child process first (triggers holder's onExit → graceful shutdown)
    process.kill(meta.childPid, "SIGTERM");
  } catch {
    // Child may already be dead — try killing the holder directly
  }

  try {
    // Also kill the holder process to ensure cleanup on Windows
    // (where SIGTERM is TerminateProcess and may not propagate to the holder)
    process.kill(meta.pid, "SIGTERM");
  } catch {
    // Holder may already be dead
  }

  process.stderr.write(`Stopped session "${name}" (PID ${meta.childPid})\n`);
}

async function cmdInfo(args: string[]): Promise<void> {
  const name = args[0];
  if (!name) die("info requires a session name");

  const meta = readMetadata(name);
  if (!meta) die(`Session "${name}" not found`);

  const active = isSessionActive(name);
  const info = { ...meta, active };
  process.stdout.write(JSON.stringify(info, null, 2) + "\n");
}

// ── Main ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(usage() + "\n");
    return;
  }

  if (args[0] === "--version" || args[0] === "-V") {
    process.stdout.write(`holdpty v${VERSION}\n`);
    return;
  }

  const cmd = args[0];
  const rest = args.slice(1);

  switch (cmd) {
    case "launch":
      await cmdLaunch(rest);
      break;
    case "__holder":
      await cmdHolder(rest);
      break;
    case "attach":
      await cmdAttach(rest);
      break;
    case "view":
      await cmdView(rest);
      break;
    case "logs":
      await cmdLogs(rest);
      break;
    case "ls":
      await cmdLs(rest);
      break;
    case "stop":
      await cmdStop(rest);
      break;
    case "info":
      await cmdInfo(rest);
      break;
    default:
      die(`Unknown command: ${cmd}\nRun 'holdpty --help' for usage`);
  }
}

main().catch((err: Error) => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
