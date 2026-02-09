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
import { TailBuffer } from "./line-filter.js";

// ── Types ──────────────────────────────────────────────────────────

export type ClientMode = "attach" | "view" | "logs";

export interface ConnectOptions {
  name: string;
  mode: ClientMode;
  /**
   * If set, called for each DATA_OUT frame during replay instead of
   * writing to stdout. After REPLAY_END, live data goes to stdout directly.
   */
  onReplayData?: (payload: Buffer) => void;
  /**
   * Called synchronously when REPLAY_END is received, before the connect
   * promise resolves. Use to flush buffered replay data.
   */
  onReplayEnd?: () => void;
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
    let replayDone = false;

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
            // For attach: don't write here — attach sets up its own handler after connect().
            if (mode === "view" || mode === "logs") {
              if (!replayDone && opts.onReplayData) {
                // During replay with a custom handler — delegate to caller
                opts.onReplayData(frame.payload);
              } else {
                process.stdout.write(frame.payload);
              }
            }
            break;

          case MSG.REPLAY_END:
            // Must flip synchronously before processing any further frames
            // in this batch (a live DATA_OUT may follow in the same chunk)
            replayDone = true;
            if (opts.onReplayEnd) {
              opts.onReplayEnd();
            }
            if (!resolved && ack) {
              resolved = true;
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

/** Default detach sequence: Ctrl+A then d (screen convention) */
const DEFAULT_DETACH_SEQ = [0x01, 0x64]; // Ctrl+A = 0x01, d = 0x64

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

  // Detach sequence detection (screen-style: no timeout)
  //
  // The prefix byte (Ctrl+A by default) enters "command mode".
  // The next byte decides: if it completes the sequence → detach.
  // If anything else → flush the prefix + the byte to the PTY.
  // To send a literal prefix byte, press it twice (Ctrl+A Ctrl+A).
  const detachSeq = parseDetachSequence();
  let detachIdx = 0;

  const onStdinData = (data: Buffer): void => {
    // Fast path: not in command mode and prefix byte not in this chunk
    if (detachIdx === 0 && !data.includes(detachSeq[0])) {
      socket.write(encodeDataIn(data));
      return;
    }

    // Slow path: byte-by-byte scan for detach sequence
    let batchStart = -1; // start of a run of normal bytes to batch-send

    const flushBatch = (end: number): void => {
      if (batchStart >= 0 && end > batchStart) {
        socket.write(encodeDataIn(data.subarray(batchStart, end)));
        batchStart = -1;
      }
    };

    for (let i = 0; i < data.length; i++) {
      const byte = data[i];

      if (detachIdx > 0 && byte === detachSeq[detachIdx]) {
        // Continuing the sequence
        flushBatch(i);
        detachIdx++;
        if (detachIdx === detachSeq.length) {
          detached = true;
          cleanup();
          return;
        }
      } else if (detachIdx === 0 && byte === detachSeq[0]) {
        // Prefix byte — enter command mode, swallow it
        flushBatch(i);
        detachIdx = 1;
      } else if (detachIdx > 0) {
        // In command mode but wrong byte — flush prefix + resume normal
        flushBatch(i);
        if (detachIdx === 1 && byte === detachSeq[0]) {
          // Double prefix (e.g., Ctrl+A Ctrl+A) → send one literal prefix
          socket.write(encodeDataIn(Buffer.from([detachSeq[0]])));
        } else {
          // Send the swallowed prefix bytes + this byte
          const flushed = Buffer.from([...detachSeq.slice(0, detachIdx), byte]);
          socket.write(encodeDataIn(flushed));
        }
        detachIdx = 0;
      } else {
        // Normal byte — batch it
        if (batchStart < 0) batchStart = i;
      }
    }

    // Flush any trailing normal bytes
    flushBatch(data.length);
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
  /** Show only the last N lines of replay. */
  tail?: number;
  /** Keep streaming live data after replay (like tail -f). */
  follow?: boolean;
  /** Skip replay entirely. Only valid with --follow. */
  noReplay?: boolean;
}

/**
 * Dump the session's output buffer to stdout and exit.
 * With --follow, keeps streaming live data after replay.
 * With --tail N, only shows the last N lines of replay.
 * With --no-replay, skips buffer replay (only valid with --follow).
 */
export async function logs(opts: LogsOptions): Promise<void> {
  const { tail, follow, noReplay } = opts;

  // --follow uses "view" mode (holder keeps connection open after REPLAY_END)
  // Without --follow, use "logs" mode (holder disconnects after REPLAY_END)
  const mode: ClientMode = follow ? "view" : "logs";

  // Build replay callbacks based on options
  let onReplayData: ((payload: Buffer) => void) | undefined;
  let onReplayEnd: (() => void) | undefined;

  if (noReplay) {
    // Skip all replay data
    onReplayData = () => {};
  } else if (tail != null) {
    // Buffer replay, flush last N lines on REPLAY_END
    const tailBuf = new TailBuffer();
    onReplayData = (payload: Buffer) => tailBuf.push(payload);
    onReplayEnd = () => {
      const data = tailBuf.flush(tail);
      if (data.length > 0) {
        process.stdout.write(data);
      }
    };
  }
  // else: default behavior — write replay data directly to stdout

  const conn = await connect({
    name: opts.name,
    mode,
    onReplayData,
    onReplayEnd,
  });

  if (follow) {
    // Wait for session to end (live streaming handled by connect's DATA_OUT handler)
    await conn.done;
  }
  // Without --follow in logs mode, holder disconnects after REPLAY_END
}
