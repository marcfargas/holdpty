import { describe, it, expect, afterEach } from "vitest";
import { Holder, type HolderOptions } from "./holder.js";
import { connect, type ClientConnection } from "./client.js";
import {
  MSG,
  FrameDecoder,
  encodeHello,
  encodeDataIn,
  decodeHelloAck,
  decodeExit,
  decodeError,
  type Frame,
} from "./protocol.js";
import { listSessions, readMetadata, removeSession } from "./session.js";
import { getSessionDir, socketPath } from "./platform.js";
import { createConnection } from "node:net";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Use a unique test directory to avoid conflicts
const testDir = join(tmpdir(), `holdpty-test-${process.pid}`);

function setTestDir(): void {
  process.env["HOLDPTY_DIR"] = testDir;
}

// Track holders for cleanup
const holders: Holder[] = [];

async function startHolder(opts: Partial<HolderOptions> & { command: string[] }): Promise<Holder> {
  setTestDir();
  const holder = await Holder.start(opts);
  holders.push(holder);
  return holder;
}

afterEach(async () => {
  // Kill all holders
  for (const h of holders) {
    try { h.kill(); } catch { /* ignore */ }
  }
  holders.length = 0;

  // Wait a bit for cleanup
  await new Promise((r) => setTimeout(r, 300));

  // Clean up test directory
  try {
    const { rmSync } = await import("node:fs");
    rmSync(testDir, { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe("Holder", () => {
  it("starts a session and creates metadata", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      name: "test-meta",
    });

    expect(holder.sessionName).toBe("test-meta");

    const meta = readMetadata("test-meta");
    expect(meta).not.toBeNull();
    expect(meta!.name).toBe("test-meta");
    expect(meta!.command).toEqual([process.execPath, "-e", "setTimeout(() => {}, 10000)"]);
    expect(meta!.cols).toBe(120);
    expect(meta!.rows).toBe(40);
  });

  it("accepts a view connection and replays buffer", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "process.stdout.write('hello from pty'); setTimeout(() => {}, 5000)"],
      name: "test-view",
    });

    // Wait for PTY to produce output
    await new Promise((r) => setTimeout(r, 500));

    // Connect as viewer
    const conn = await connect({ name: "test-view", mode: "view" });
    expect(conn.ack.name).toBe("test-view");
    expect(conn.ack.mode).toBe("view");

    // Socket should be connected
    expect(conn.socket.destroyed).toBe(false);

    conn.socket.end();
  });

  it("attach replays buffer including ANSI escape sequences", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "process.stdout.write('\\x1b[31mred\\x1b[0m normal'); setTimeout(() => {}, 5000)"],
      name: "test-attach-replay",
    });

    // Wait for PTY to produce output
    await new Promise((r) => setTimeout(r, 500));

    // Connect as attach with onReplayData to capture replay
    const replayChunks: Buffer[] = [];
    const conn = await connect({
      name: "test-attach-replay",
      mode: "attach",
      onReplayData: (payload) => replayChunks.push(payload),
    });

    expect(conn.ack.mode).toBe("attach");

    const replay = Buffer.concat(replayChunks).toString();
    // The replay should contain the ANSI escape (may be wrapped by PTY)
    expect(replay).toContain("red");
    expect(replay).toContain("normal");

    conn.socket.end();
  });

  it("accepts logs connection and disconnects after replay", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "process.stdout.write('log output'); setTimeout(() => {}, 5000)"],
      name: "test-logs",
    });

    // Wait for output
    await new Promise((r) => setTimeout(r, 500));

    // Connect as logs — should get data and disconnect
    const conn = await connect({ name: "test-logs", mode: "logs" });
    expect(conn.ack.name).toBe("test-logs");
    expect(conn.ack.mode).toBe("logs");
  });

  it("rejects second attach", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      name: "test-excl",
    });

    // First attach
    const conn1 = await connect({ name: "test-excl", mode: "attach" });
    expect(conn1.ack.mode).toBe("attach");

    // Second attach should fail
    await expect(connect({ name: "test-excl", mode: "attach" }))
      .rejects.toThrow("active attachment");

    conn1.socket.end();
  });

  it("allows attach after first attach disconnects", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      name: "test-reattach",
    });

    // First attach
    const conn1 = await connect({ name: "test-reattach", mode: "attach" });
    conn1.socket.end();

    // Wait for disconnect to be processed
    await new Promise((r) => setTimeout(r, 100));

    // Second attach should succeed
    const conn2 = await connect({ name: "test-reattach", mode: "attach" });
    expect(conn2.ack.mode).toBe("attach");
    conn2.socket.end();
  });

  it("allows multiple simultaneous viewers", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      name: "test-multiview",
    });

    const conn1 = await connect({ name: "test-multiview", mode: "view" });
    const conn2 = await connect({ name: "test-multiview", mode: "view" });
    const conn3 = await connect({ name: "test-multiview", mode: "view" });

    expect(conn1.socket.destroyed).toBe(false);
    expect(conn2.socket.destroyed).toBe(false);
    expect(conn3.socket.destroyed).toBe(false);

    conn1.socket.end();
    conn2.socket.end();
    conn3.socket.end();
  });

  it("sends EXIT when child process exits", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "process.exit(42)"],
      name: "test-exit",
    });

    const code = await holder.waitForExit();
    expect(code).toBe(42);
  }, 15000); // Longer timeout due to 5s linger

  it("auto-generates name when not provided", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
    });

    expect(holder.sessionName).toMatch(/^node-[a-f0-9]{4}$/);
  });
});

describe("listSessions", () => {
  it("lists active sessions", async () => {
    setTestDir();
    const holder = await startHolder({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      name: "test-list",
    });

    const sessions = await listSessions();
    const found = sessions.find((s) => s.name === "test-list");
    expect(found).toBeDefined();
    expect(found!.metadata.name).toBe("test-list");
  });
});

describe("protocol handshake", () => {
  it("rejects unsupported protocol version", async () => {
    const holder = await startHolder({
      command: [process.execPath, "-e", "setTimeout(() => {}, 10000)"],
      name: "test-proto",
    });

    const dir = getSessionDir();
    const sockPath = socketPath(dir, "test-proto");

    // Connect raw and send a HELLO with bad version
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(sockPath, () => {
        socket.write(encodeHello({ mode: "view", protocolVersion: 99 }));
      });

      const decoder = new FrameDecoder();
      socket.on("data", (chunk) => {
        const frames = decoder.decode(chunk);
        for (const frame of frames) {
          if (frame.type === MSG.ERROR) {
            const msg = decodeError(frame.payload);
            expect(msg).toContain("Unsupported protocol version");
            socket.end();
            resolve();
            return;
          }
        }
      });

      socket.on("error", reject);
      setTimeout(() => reject(new Error("Timeout")), 3000);
    });
  });
});
