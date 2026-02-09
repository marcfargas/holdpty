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
 * Resolve a command name to a full path on Windows.
 *
 * node-pty on Windows doesn't search PATH the way cmd.exe does.
 * `pty.spawn("node", ...)` fails — needs `pty.spawn("node.exe", ...)` or
 * a full path. This function tries PATHEXT extensions and PATH directories.
 *
 * On non-Windows, returns the command unchanged (forkpty handles it).
 */
export function resolveCommand(command: string): string {
  if (!IS_WINDOWS) return command;

  // Already has an extension or is an absolute path that exists
  if (extname(command) !== "") return command;

  // PATHEXT extensions to try (e.g. .exe, .cmd, .bat)
  // We only want real executables, not .cmd/.bat (node-pty can't run those)
  const exeExtensions = [".exe", ".com"];

  // Check if it's a relative/absolute path (contains separator)
  if (command.includes("/") || command.includes("\\")) {
    for (const ext of exeExtensions) {
      if (existsSync(command + ext)) return command + ext;
    }
    return command;
  }

  // Search PATH
  const pathDirs = (process.env["PATH"] ?? "").split(";").filter(Boolean);
  for (const dir of pathDirs) {
    for (const ext of exeExtensions) {
      const candidate = join(dir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }

  // Fallback: try just appending .exe (let node-pty give the error)
  return command + ".exe";
}
