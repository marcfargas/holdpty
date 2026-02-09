import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveSessionDir, socketPath, metadataPath, isWindows } from "./platform.js";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("platform", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    // Restore env
    process.env = { ...origEnv };
  });

  describe("resolveSessionDir", () => {
    it("uses HOLDPTY_DIR when set", () => {
      process.env["HOLDPTY_DIR"] = "/custom/dir";
      expect(resolveSessionDir()).toBe("/custom/dir");
    });

    it("falls back to platform default when HOLDPTY_DIR is unset", () => {
      delete process.env["HOLDPTY_DIR"];
      const dir = resolveSessionDir();
      expect(dir).toContain("dt");
      expect(dir.length).toBeGreaterThan(0);
    });
  });

  describe("socketPath", () => {
    it("returns correct path for platform", () => {
      const p = socketPath("/tmp/dt", "worker1");
      if (isWindows) {
        // Named pipe includes hash of session dir for isolation
        expect(p).toMatch(/^\/\/\.\/pipe\/holdpty-[a-f0-9]{8}-worker1$/);
      } else {
        expect(p).toBe(join("/tmp/dt", "worker1.sock"));
      }
    });

    it("different session dirs produce different pipe names on Windows", () => {
      if (!isWindows) return;
      const p1 = socketPath("/tmp/dt-a", "test");
      const p2 = socketPath("/tmp/dt-b", "test");
      expect(p1).not.toBe(p2);
    });
  });

  describe("metadataPath", () => {
    it("appends .json extension", () => {
      const p = metadataPath("/tmp/dt", "worker1");
      expect(p).toBe(join("/tmp/dt", "worker1.json"));
    });
  });

  describe("isWindows", () => {
    it("matches process.platform", () => {
      expect(isWindows).toBe(process.platform === "win32");
    });
  });
});
