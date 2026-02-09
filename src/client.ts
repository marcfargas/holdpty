/**
 * Client connections: attach, view, logs.
 *
 * Connects to a holder process over a Unix domain socket.
 */

import { createConnection, type Socket } from "node:net";
import { getSessionDir, socketPath } from "./platform.js";
import { readMetadata, isSessionActive } from "./session.js";
import {
  MSG,
  FrameDecoder,
  encodeHello,
  encodeDataIn,
  encodeResize,
  decodeHelloAck,
  decodeExit,
  decodeError,
  type Frame,
  type HelloAckPayload,
} from "./protocol.js";

// ── Types ──────────────────────────────────────────────────────────

export type ClientMode = "attach" | "view" | "logs";

export interface ConnectOptions {
  name: string;
  mode: ClientMode;
}

export interface ClientConnection {
  socket: Socket;
  ack: HelloAckPayload;
  /** Promise that resolves when the connection ends. Value is exit code or null. */
  done: Promise<number | null>;
}

// ── Connect ────────────────────────────────────────────────────────

/**
 * Connect to a session. Performs the HELLO handshake and buffer replay.
 */
export function connect(opts: ConnectOptions): Promise<ClientConnection> {
  const { name, mode } = opts;
  const dir = getSessionDir();
  const sockPath = socketPath(dir, name);

  // Pre-check: does the session exist?
  const meta = readMetadata(name);
  if (!meta) {
    return Promise.reject(new Error(`Session "${name}" not found`));
  }

  return new Promise((resolve, reject) => {
    const socket: Socket = createConnection(sockPath, () => {
      // Send HELLO
      socket.write(encodeHello({ mode, protocolVersion: 1 }));
    });

    const decoder = new FrameDecoder();
    let ack: HelloAckPayload | null = null;
    let resolved = false;

    // done promise: resolves when connection ends
    let resolveDone: (code: number | null) => void;
    const done = new Promise<number | null>((r) => {
      resolveDone = r;
    });

    socket.on("data", (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = decoder.decode(chunk);
      } catch {
        if (!resolved) {
          resolved = true;
          reject(new Error("Malformed data from holder"));
        }
        return;
      }

      for (const frame of frames) {
        switch (frame.type) {
          case MSG.HELLO_ACK:
            ack = decodeHelloAck(frame.payload);
            break;

          case MSG.ERROR: {
            const msg = decodeError(frame.payload);
            if (!resolved) {
              resolved = true;
              reject(new Error(msg));
            }
            break;
          }

          case MSG.DATA_OUT:
            // Write data to stdout for view and logs modes.
            // For view: write both replay (before REPLAY_END) and live data.
            // For logs: write replay data (holder disconnects after REPLAY_END).
            // For attach: don't write here — attach sets up its own handler after connect().
            if (mode === "view" || mode === "logs") {
              process.stdout.write(frame.payload);
            }
            break;

          case MSG.REPLAY_END:
            if (!resolved && ack) {
              resolved = true;
              // For logs mode, data was already written during replay
              // Resolve the connect promise
              resolve({ socket, ack, done });
            }
            break;

          case MSG.EXIT: {
            const { code } = decodeExit(frame.payload);
            resolveDone!(code);
            break;
          }

          default:
            // Unknown — ignore
            break;
        }
      }
    });

    socket.on("error", (err: Error) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Cannot connect to session "${name}": ${err.message}`));
      }
      resolveDone!(null);
    });

    socket.on("close", () => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Connection to "${name}" closed during handshake`));
      }
      resolveDone!(null);
    });
  });
}

// ── Attach ─────────────────────────────────────────────────────────

/** Default detach sequence: Ctrl+] then d */
const DEFAULT_DETACH_SEQ = [0x1d, 0x64]; // Ctrl+] = 0x1d, d = 0x64

/**
 * Parse the HOLDPTY_DETACH env var into a byte sequence.
 * Format: comma-separated hex bytes, e.g. "0x01,0x64"
 */
function parseDetachSequence(): number[] {
  const raw = process.env["HOLDPTY_DETACH"];
  if (!raw) return DEFAULT_DETACH_SEQ;

  try {
    const bytes = raw.split(",").map((s) => {
      const n = parseInt(s.trim(), 16);
      if (isNaN(n) || n < 0 || n > 255) throw new Error();
      return n;
    });
    if (bytes.length < 1) return DEFAULT_DETACH_SEQ;
    return bytes;
  } catch {
    return DEFAULT_DETACH_SEQ;
  }
}

export interface AttachOptions {
  name: string;
}

/**
 * Attach to a session interactively.
 * Takes over the terminal (raw mode). Returns exit code or null (detach).
 */
export async function attach(opts: AttachOptions): Promise<number | null> {
  const conn = await connect({ name: opts.name, mode: "attach" });
  const { socket, ack, done } = conn;

  // Replay data was already handled during connect
  // Now set up live streaming

  // Write live data to stdout
  const decoder = new FrameDecoder();
  let exitCode: number | null = null;
  let detached = false;

  socket.on("data", (chunk: Buffer) => {
    let frames: Frame[];
    try {
      frames = decoder.decode(chunk);
    } catch {
      return;
    }
    for (const frame of frames) {
      if (frame.type === MSG.DATA_OUT) {
        process.stdout.write(frame.payload);
      } else if (frame.type === MSG.EXIT) {
        exitCode = decodeExit(frame.payload).code;
      }
    }
  });

  // Enter raw mode
  if (!process.stdin.isTTY) {
    throw new Error("attach requires a TTY (interactive terminal)");
  }
  process.stdin.setRawMode(true);
  process.stdin.resume();

  // Detach sequence detection
  const detachSeq = parseDetachSequence();
  let detachIdx = 0;
  const DETACH_TIMEOUT = 200; // ms
  let detachTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingBytes: number[] = [];

  const flushPending = (): void => {
    if (pendingBytes.length > 0) {
      socket.write(encodeDataIn(Buffer.from(pendingBytes)));
      pendingBytes = [];
    }
    detachIdx = 0;
    if (detachTimer) {
      clearTimeout(detachTimer);
      detachTimer = null;
    }
  };

  const onStdinData = (data: Buffer): void => {
    for (const byte of data) {
      if (byte === detachSeq[detachIdx]) {
        pendingBytes.push(byte);
        detachIdx++;
        if (detachIdx === detachSeq.length) {
          // Full detach sequence detected
          detached = true;
          cleanup();
          return;
        }
        // Set/reset timeout for the intermediate bytes
        if (detachTimer) clearTimeout(detachTimer);
        detachTimer = setTimeout(flushPending, DETACH_TIMEOUT);
      } else {
        // Not part of the sequence — flush any pending bytes + this one
        pendingBytes.push(byte);
        const toSend = Buffer.from(pendingBytes);
        pendingBytes = [];
        detachIdx = 0;
        if (detachTimer) {
          clearTimeout(detachTimer);
          detachTimer = null;
        }
        socket.write(encodeDataIn(toSend));
      }
    }
  };

  // Send resize on terminal size change
  const onResize = (): void => {
    if (process.stdout.columns && process.stdout.rows) {
      socket.write(encodeResize(process.stdout.columns, process.stdout.rows));
    }
  };

  process.stdin.on("data", onStdinData);
  process.stdout.on("resize", onResize);

  // Send initial resize
  onResize();

  const cleanup = (): void => {
    process.stdin.removeListener("data", onStdinData);
    process.stdout.removeListener("resize", onResize);
    if (detachTimer) clearTimeout(detachTimer);
    try {
      process.stdin.setRawMode(false);
      process.stdin.pause();
    } catch {
      // May fail if stdin is already closed
    }
    socket.end();
  };

  // Wait for connection to end
  const code = await done;

  if (!detached) {
    cleanup();
    return code ?? exitCode;
  }

  return null; // Detached
}

// ── View ───────────────────────────────────────────────────────────

export interface ViewOptions {
  name: string;
}

/**
 * View a session (read-only live stream).
 * Writes PTY data to stdout. Returns when the session ends.
 *
 * Data output (both replay and live) is handled by connect()'s data listener.
 */
export async function view(opts: ViewOptions): Promise<void> {
  const conn = await connect({ name: opts.name, mode: "view" });
  await conn.done;
}

// ── Logs ───────────────────────────────────────────────────────────

export interface LogsOptions {
  name: string;
}

/**
 * Dump the session's output buffer to stdout and exit.
 */
export async function logs(opts: LogsOptions): Promise<void> {
  // connect() in logs mode writes data to stdout during handshake
  // and the holder disconnects after REPLAY_END
  await connect({ name: opts.name, mode: "logs" });
}
