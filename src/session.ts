/**
 * Session directory management: metadata CRUD, listing, stale detection.
 *
 * The filesystem IS the registry. Each session has:
 *   {name}.sock  — Unix domain socket
 *   {name}.json  — Metadata
 */

import { readFileSync, writeFileSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { getSessionDir, socketPath, metadataPath, isWindows } from "./platform.js";
import { createConnection, type Socket } from "node:net";

// ── Types ──────────────────────────────────────────────────────────

export interface SessionMetadata {
  name: string;
  pid: number;
  childPid: number;
  command: string[];
  cols: number;
  rows: number;
  startedAt: string;
}

export interface SessionInfo {
  name: string;
  metadata: SessionMetadata;
  socketExists: boolean;
}

// ── Name generation ────────────────────────────────────────────────

/**
 * Generate a session name from a command: `basename-xxxx`
 */
export function generateName(command: string[]): string {
  const base = basename(command[0] ?? "session")
    .replace(/\.(exe|cmd|bat|sh|ps1)$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 16)
    || "session";
  const hex = Math.random().toString(16).slice(2, 6);
  return `${base}-${hex}`;
}

/**
 * Validate a session name.
 */
export function validateName(name: string): void {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new Error(`Invalid session name "${name}": only alphanumerics, hyphens, and underscores allowed`);
  }
  if (name.length > 64) {
    throw new Error(`Session name too long (max 64 chars)`);
  }
}

// ── Metadata CRUD ──────────────────────────────────────────────────

/**
 * Write session metadata to disk.
 */
export function writeMetadata(meta: SessionMetadata): void {
  const dir = getSessionDir();
  const path = metadataPath(dir, meta.name);
  writeFileSync(path, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Read session metadata from disk.
 */
export function readMetadata(name: string): SessionMetadata | null {
  const dir = getSessionDir();
  const path = metadataPath(dir, name);
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as SessionMetadata;
  } catch {
    return null;
  }
}

/**
 * Remove session files (socket + metadata).
 */
export function removeSession(name: string): void {
  const dir = getSessionDir();
  const meta = metadataPath(dir, name);
  // On Linux/macOS, clean up socket file. Named pipes on Windows clean up automatically.
  if (!isWindows) {
    const sock = socketPath(dir, name);
    try { unlinkSync(sock); } catch { /* ignore */ }
  }
  try { unlinkSync(meta); } catch { /* ignore */ }
}

// ── Listing ────────────────────────────────────────────────────────

/**
 * List all sessions, with optional stale cleanup.
 */
export async function listSessions(opts: { clean?: boolean } = {}): Promise<SessionInfo[]> {
  const dir = getSessionDir();
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }

  const jsonFiles = entries.filter((f) => f.endsWith(".json"));
  const results: SessionInfo[] = [];

  for (const file of jsonFiles) {
    const name = file.replace(/\.json$/, "");
    const meta = readMetadata(name);
    if (!meta) continue;

    // On Windows, named pipes don't exist as files. Check if process is alive instead.
    const sockExists = isWindows ? isProcessAlive(meta.pid) : existsSync(socketPath(dir, name));

    // Stale detection: check if holder PID is alive
    const alive = isProcessAlive(meta.pid);

    if (!alive) {
      if (opts.clean !== false) {
        // Verify socket is dead too
        const reachable = await isSocketReachable(socketPath(dir, name));
        if (!reachable) {
          removeSession(name);
          continue; // Cleaned — don't include in results
        }
      }
    }

    results.push({ name, metadata: meta, socketExists: sockExists });
  }

  return results;
}

/**
 * Check if a session name is in use (metadata exists and process is alive).
 */
export function isSessionActive(name: string): boolean {
  const meta = readMetadata(name);
  if (!meta) return false;
  return isProcessAlive(meta.pid);
}

// ── Process detection ──────────────────────────────────────────────

/**
 * Check if a process with the given PID is alive.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 = test existence
    return true;
  } catch {
    return false;
  }
}

/**
 * Try to connect to a socket with a short timeout.
 */
function isSocketReachable(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 100);

    const socket: Socket = createConnection(path, () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}
