/**
 * Platform-specific paths and utilities.
 *
 * Session directory (for metadata .json files):
 *   Windows: %TEMP%\dt\
 *   Linux:   $XDG_RUNTIME_DIR/dt/ or /tmp/dt-$UID/
 *
 * Socket paths:
 *   Windows: Named pipes (//./pipe/holdpty-<name>)
 *   Linux:   Unix domain sockets ({sessionDir}/{name}.sock)
 *
 * Override metadata dir via HOLDPTY_DIR environment variable.
 */

import { mkdirSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, extname, dirname, isAbsolute } from "node:path";

const IS_WINDOWS = process.platform === "win32";

/**
 * Get the session directory path (ensures it exists).
 * This is where metadata .json files are stored.
 */
export function getSessionDir(): string {
  const dir = resolveSessionDir();
  mkdirSync(dir, { recursive: true, mode: IS_WINDOWS ? undefined : 0o700 });
  return dir;
}

/**
 * Resolve the session directory path without creating it.
 */
export function resolveSessionDir(): string {
  if (process.env["HOLDPTY_DIR"]) {
    return process.env["HOLDPTY_DIR"];
  }

  if (IS_WINDOWS) {
    return join(tmpdir(), "dt");
  }

  // Linux / macOS
  const xdg = process.env["XDG_RUNTIME_DIR"];
  if (xdg) {
    return join(xdg, "dt");
  }

  const uid = process.getuid?.();
  if (uid !== undefined) {
    return `/tmp/dt-${uid}`;
  }

  // Fallback (shouldn't happen on Linux, but be safe)
  return join(tmpdir(), "dt");
}

/**
 * Socket/pipe path for a session name.
 *
 * On Windows: named pipe `//./pipe/holdpty-<name>`
 * On Linux/macOS: Unix domain socket `{sessionDir}/{name}.sock`
 */
export function socketPath(sessionDir: string, name: string): string {
  if (IS_WINDOWS) {
    // Named pipes are system-global. Hash the session dir to namespace them,
    // so different HOLDPTY_DIR values get isolated pipe names.
    const dirHash = createHash("md5").update(sessionDir).digest("hex").slice(0, 8);
    return `//./pipe/holdpty-${dirHash}-${name}`;
  }
  return join(sessionDir, `${name}.sock`);
}

/**
 * Metadata file path for a session name.
 */
export function metadataPath(sessionDir: string, name: string): string {
  return join(sessionDir, `${name}.json`);
}

/**
 * Default shell for the current platform.
 */
export function defaultShell(): string {
  if (IS_WINDOWS) {
    return process.env["COMSPEC"] ?? "cmd.exe";
  }
  return process.env["SHELL"] ?? "/bin/sh";
}

/**
 * Whether the current platform is Windows.
 */
export const isWindows = IS_WINDOWS;

/**
 * Resolved command for pty.spawn() on Windows.
 *
 * node-pty on Windows can't search PATH, resolve PATHEXT, or run
 * .cmd/.bat files. This function finds the actual file and returns
 * the shell + args needed to execute it.
 *
 * Returns { shell, args } where shell is what to pass to pty.spawn()
 * and args replaces the original args array.
 *
 * On non-Windows, returns the command unchanged.
 */
export function resolveCommand(command: string[]): { shell: string; args: string[] } {
  if (!IS_WINDOWS) return { shell: command[0], args: command.slice(1) };

  const cmd = command[0];
  const rest = command.slice(1);

  // Already has an extension — check what kind
  const ext = extname(cmd).toLowerCase();
  if (ext === ".cmd" || ext === ".bat") {
    return { shell: "cmd.exe", args: ["/c", ...command] };
  }
  if (ext !== "") {
    // .exe, .com, or other — pass through
    return { shell: cmd, args: rest };
  }

  // No extension — search for the actual file
  const dirs = cmd.includes("/") || cmd.includes("\\")
    ? [""]  // relative/absolute path — search in place
    : (process.env["PATH"] ?? "").split(";").filter(Boolean);

  // Prefer .exe/.com (native), then .cmd/.bat (needs cmd.exe wrapper)
  const nativeExts = [".exe", ".com"];
  const scriptExts = [".cmd", ".bat"];

  for (const dir of dirs) {
    const base = dir ? join(dir, cmd) : cmd;
    for (const e of nativeExts) {
      if (existsSync(base + e)) return { shell: base + e, args: rest };
    }
    // Also check extensionless file (e.g., npm shims on Windows that are shell scripts)
    if (existsSync(base) && !existsSync(base + ".exe")) {
      // Could be a shell script or extensionless binary — try it directly
      for (const e of scriptExts) {
        if (existsSync(base + e)) return { shell: "cmd.exe", args: ["/c", ...command] };
      }
    }
    for (const e of scriptExts) {
      if (existsSync(base + e)) return { shell: "cmd.exe", args: ["/c", ...command] };
    }
  }

  // Fallback: try as-is with .exe
  return { shell: cmd + ".exe", args: rest };
}
