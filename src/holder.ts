/**
 * Holder process: owns the PTY, manages the ring buffer, accepts clients
 * over a Unix domain socket.
 *
 * One holder per session. No central daemon.
 */

import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import * as pty from "node-pty";
import { RingBuffer, DEFAULT_CAPACITY } from "./ring-buffer.js";
import {
  MSG,
  FrameDecoder,
  encodeDataOut,
  encodeExit,
  encodeError,
  encodeHelloAck,
  encodeReplayEnd,
  decodeHello,
  decodeResize,
  type Frame,
  type HelloPayload,
} from "./protocol.js";
import {
  getSessionDir,
  socketPath,
  metadataPath,
  isWindows,
  resolveCommand,
} from "./platform.js";
import {
  writeMetadata,
  removeSession,
  validateName,
  generateName,
  type SessionMetadata,
} from "./session.js";

// ── Types ──────────────────────────────────────────────────────────

export interface HolderOptions {
  command: string[];
  name?: string;
  cols?: number;
  rows?: number;
  cwd?: string;
  env?: Record<string, string>;
}

interface ClientConnection {
  socket: Socket;
  decoder: FrameDecoder;
  mode: "attach" | "view" | "logs" | null; // null = pre-handshake
}

// ── Holder ─────────────────────────────────────────────────────────

export class Holder {
  private readonly name: string;
  private readonly sessionDir: string;
  private readonly ringBuffer: RingBuffer;
  private readonly ptyProcess: pty.IPty;
  private readonly server: Server;
  private readonly clients: Set<ClientConnection> = new Set();
  private writer: ClientConnection | null = null;
  private childExitCode: number | null = null;
  private childExited = false;
  private shuttingDown = false;
  private resolveShutdown!: () => void;
  private readonly shutdownDone: Promise<void>;

  private constructor(
    name: string,
    sessionDir: string,
    ptyProcess: pty.IPty,
    server: Server,
  ) {
    this.name = name;
    this.sessionDir = sessionDir;
    this.ringBuffer = new RingBuffer(DEFAULT_CAPACITY);
    this.ptyProcess = ptyProcess;
    this.server = server;
    this.shutdownDone = new Promise<void>((resolve) => {
      this.resolveShutdown = resolve;
    });
  }

  /**
   * Create and start a holder. Returns when the PTY + socket are ready.
   */
  static async start(opts: HolderOptions): Promise<Holder> {
    const name = opts.name ?? generateName(opts.command);
    validateName(name);

    const sessionDir = getSessionDir();
    const sockPath = socketPath(sessionDir, name);

    // On Linux/macOS, clean up any leftover socket file from a crashed session
    // Named pipes on Windows don't leave files
    if (!isWindows && existsSync(sockPath)) {
      try { unlinkSync(sockPath); } catch { /* ignore */ }
    }

    const cols = opts.cols ?? 120;
    const rows = opts.rows ?? 40;

    // Spawn PTY
    // On Windows, node-pty doesn't search PATH like cmd.exe does.
    // resolveCommand() finds the .exe so `node` works, not just `node.exe`.
    const shell = resolveCommand(opts.command[0]);
    const args = opts.command.slice(1);
    const ptyProcess = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: opts.cwd ?? process.cwd(),
      env: opts.env ?? (process.env as Record<string, string>),
    });

    // Create Unix domain socket server
    const server = createServer();
    const holder = new Holder(name, sessionDir, ptyProcess, server);

    // Wire up PTY events
    holder.setupPty();

    // Start listening BEFORE writing metadata.
    // Metadata signals "session exists" — it must only appear when the
    // socket is actually connectable (avoids TOCTOU).
    await holder.listen(sockPath);

    // Wire up server events
    holder.setupServer();

    // Now write metadata — the session is fully ready
    const meta: SessionMetadata = {
      name,
      pid: process.pid,
      childPid: ptyProcess.pid,
      command: opts.command,
      cols,
      rows,
      startedAt: new Date().toISOString(),
    };
    writeMetadata(meta);

    return holder;
  }

  /**
   * The session name.
   */
  get sessionName(): string {
    return this.name;
  }

  /**
   * Wait for the holder to shut down (child exit + cleanup).
   * Returns the child's exit code.
   */
  async waitForExit(): Promise<number> {
    await this.shutdownDone;
    return this.childExitCode ?? -1;
  }

  /**
   * Bridge stdin/stdout directly to the PTY (for --fg mode).
   *
   * This is a lightweight alternative to socket-based attach for cases
   * where the holder runs in the same process. If stdin is a TTY, raw
   * mode is enabled and resize events are forwarded.
   *
   * Returns the child's exit code when the child process exits.
   */
  async pipeStdio(): Promise<number> {
    // Wire PTY output → stdout (in addition to the ring buffer + broadcast
    // that setupPty already handles)
    this.ptyProcess.onData((data: string) => {
      process.stdout.write(data, "binary");
    });

    // Wire stdin → PTY input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    const onStdinData = (data: Buffer): void => {
      try {
        this.ptyProcess.write(data.toString("binary"));
      } catch {
        // PTY may have closed
      }
    };
    process.stdin.on("data", onStdinData);

    // Forward terminal resize events
    const onResize = (): void => {
      if (process.stdout.columns && process.stdout.rows) {
        try {
          this.ptyProcess.resize(process.stdout.columns, process.stdout.rows);
        } catch {
          // PTY may have closed
        }
      }
    };
    if (process.stdin.isTTY) {
      process.stdout.on("resize", onResize);
      // Send initial size
      onResize();
    }

    const code = await this.waitForExit();

    // Cleanup
    process.stdin.removeListener("data", onStdinData);
    process.stdout.removeListener("resize", onResize);
    try {
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
    } catch {
      // Already closed
    }

    return code;
  }

  // ── PTY wiring ─────────────────────────────────────────────────

  private setupPty(): void {
    this.ptyProcess.onData((data: string) => {
      const buf = Buffer.from(data, "binary");
      this.ringBuffer.write(buf);
      this.broadcast(encodeDataOut(buf));
    });

    this.ptyProcess.onExit(({ exitCode }) => {
      this.childExitCode = exitCode;
      this.childExited = true;

      // Delay to let ConPTY flush remaining output
      const drainMs = isWindows ? 200 : 100;
      setTimeout(() => {
        this.shutdown();
      }, drainMs);
    });
  }

  // ── Server wiring ──────────────────────────────────────────────

  private listen(sockPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(sockPath, () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
  }

  private setupServer(): void {
    this.server.on("connection", (socket: Socket) => {
      this.handleConnection(socket);
    });
  }

  // ── Client connection handling ─────────────────────────────────

  private handleConnection(socket: Socket): void {
    const client: ClientConnection = {
      socket,
      decoder: new FrameDecoder(),
      mode: null,
    };
    this.clients.add(client);

    socket.on("data", (chunk: Buffer) => {
      let frames: Frame[];
      try {
        frames = client.decoder.decode(chunk);
      } catch {
        this.sendError(socket, "Malformed frame");
        socket.destroy();
        return;
      }

      for (const frame of frames) {
        this.handleFrame(client, frame);
      }
    });

    socket.on("close", () => {
      this.disconnectClient(client);
    });

    socket.on("error", () => {
      this.disconnectClient(client);
    });
  }

  private handleFrame(client: ClientConnection, frame: Frame): void {
    // Pre-handshake: only HELLO is valid
    if (client.mode === null) {
      if (frame.type !== MSG.HELLO) {
        this.sendError(client.socket, "Expected HELLO");
        client.socket.destroy();
        return;
      }

      let hello: HelloPayload;
      try {
        hello = decodeHello(frame.payload);
      } catch {
        this.sendError(client.socket, "Invalid HELLO payload");
        client.socket.destroy();
        return;
      }

      if (hello.protocolVersion !== 1) {
        this.sendError(client.socket, `Unsupported protocol version: ${hello.protocolVersion}`);
        client.socket.destroy();
        return;
      }

      // Check attach exclusivity
      if (hello.mode === "attach" && this.writer !== null) {
        this.sendError(client.socket, `Session "${this.name}" has an active attachment. Use 'holdpty view ${this.name}' for read-only access.`);
        client.socket.destroy();
        return;
      }

      // Accept connection
      client.mode = hello.mode;
      if (hello.mode === "attach") {
        this.writer = client;
      }

      // Send HELLO_ACK
      const ack = encodeHelloAck({
        name: this.name,
        cols: this.ptyProcess.cols,
        rows: this.ptyProcess.rows,
        mode: hello.mode,
        pid: this.ptyProcess.pid,
      });
      client.socket.write(ack);

      // Replay buffer
      const bufData = this.ringBuffer.read();
      if (bufData.length > 0) {
        client.socket.write(encodeDataOut(bufData));
      }

      // Send REPLAY_END
      client.socket.write(encodeReplayEnd());

      // For logs mode: disconnect after replay
      if (hello.mode === "logs") {
        client.socket.end();
      }

      // If child already exited, send EXIT
      if (this.childExited && hello.mode !== "logs") {
        client.socket.write(encodeExit(this.childExitCode ?? -1));
        client.socket.end();
      }

      return;
    }

    // Post-handshake: handle data frames
    switch (frame.type) {
      case MSG.DATA_IN:
        if (client.mode === "attach") {
          try {
            this.ptyProcess.write(frame.payload.toString("binary"));
          } catch {
            // PTY may have closed
          }
        }
        break;

      case MSG.RESIZE:
        if (client.mode === "attach") {
          try {
            const { cols, rows } = decodeResize(frame.payload);
            this.ptyProcess.resize(cols, rows);
          } catch {
            // PTY may have closed, or invalid resize
          }
        }
        break;

      default:
        // Unknown/unexpected — ignore (forward-compatible)
        break;
    }
  }

  // ── Broadcasting ───────────────────────────────────────────────

  private broadcast(data: Buffer): void {
    for (const client of this.clients) {
      if (client.mode === "attach" || client.mode === "view") {
        try {
          client.socket.write(data);
        } catch {
          // Client gone — will be cleaned on close event
        }
      }
    }
  }

  private sendError(socket: Socket, message: string): void {
    try {
      socket.write(encodeError(message));
    } catch {
      // Socket may already be dead
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────

  private disconnectClient(client: ClientConnection): void {
    if (this.writer === client) {
      this.writer = null;
    }
    this.clients.delete(client);
    try {
      client.socket.destroy();
    } catch {
      // Already destroyed
    }
  }

  private shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    // Notify all connected clients
    const exitFrame = encodeExit(this.childExitCode ?? -1);
    for (const client of this.clients) {
      if (client.mode === "attach" || client.mode === "view") {
        try {
          client.socket.write(exitFrame);
          client.socket.end();
        } catch {
          // Ignore write errors during shutdown
        }
      }
    }

    // Linger for late connections (default 5s per DESIGN.md, configurable for tests)
    const lingerMs = parseInt(process.env["HOLDPTY_LINGER_MS"] ?? "5000", 10) || 5000;
    setTimeout(() => {
      // Force-close remaining clients
      for (const client of this.clients) {
        try { client.socket.destroy(); } catch { /* ignore */ }
      }
      this.clients.clear();
      this.writer = null;

      // Close server
      this.server.close(() => {
        // Clean up files
        removeSession(this.name);
        this.shuttingDown = false;
        this.resolveShutdown();
      });
    }, lingerMs);
  }

  /**
   * Stop the child process. Used by the `stop` command.
   */
  kill(signal?: string): void {
    try {
      this.ptyProcess.kill(signal);
    } catch {
      // Process may already be dead
    }
  }
}
