/**
 * Tests for line-filter.ts — TailBuffer.
 */

import { describe, it, expect } from "vitest";
import { TailBuffer } from "./line-filter.js";

describe("TailBuffer", () => {
  it("returns empty buffer for flush(0)", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("line1\nline2\nline3\n"));
    expect(buf.flush(0)).toEqual(Buffer.alloc(0));
  });

  it("returns everything when fewer lines than requested", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("line1\nline2\n"));
    const result = buf.flush(10);
    expect(result.toString()).toBe("line1\nline2\n");
  });

  it("returns last N lines from a single chunk", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("line1\nline2\nline3\nline4\n"));
    const result = buf.flush(2);
    expect(result.toString()).toBe("line3\nline4\n");
  });

  it("returns last N lines across multiple chunks", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("line1\nline2\n"));
    buf.push(Buffer.from("line3\nline4\n"));
    buf.push(Buffer.from("line5\n"));
    const result = buf.flush(3);
    expect(result.toString()).toBe("line3\nline4\nline5\n");
  });

  it("handles trailing partial line (no final \\n)", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("line1\nline2\npartial"));
    const result = buf.flush(2);
    expect(result.toString()).toBe("line2\npartial");
  });

  it("handles single line with no newline", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("just some text"));
    const result = buf.flush(1);
    expect(result.toString()).toBe("just some text");
  });

  it("handles single line with newline", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("single line\n"));
    const result = buf.flush(1);
    expect(result.toString()).toBe("single line\n");
  });

  it("returns empty for empty buffer", () => {
    const buf = new TailBuffer();
    expect(buf.flush(5)).toEqual(Buffer.alloc(0));
  });

  it("handles \\r\\n line endings (counts only \\n)", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("line1\r\nline2\r\nline3\r\n"));
    const result = buf.flush(2);
    expect(result.toString()).toBe("line2\r\nline3\r\n");
  });

  it("handles chunk boundary splitting a line", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("aaa\nbbb"));
    buf.push(Buffer.from("ccc\nddd\n"));
    // Lines: "aaa", "bbbccc", "ddd"
    const result = buf.flush(2);
    expect(result.toString()).toBe("bbbccc\nddd\n");
  });

  it("handles chunk boundary at \\n", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("line1\n"));
    buf.push(Buffer.from("line2\n"));
    buf.push(Buffer.from("line3\n"));
    const result = buf.flush(1);
    expect(result.toString()).toBe("line3\n");
  });

  it("tail 1 from data with trailing newline", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("a\nb\nc\n"));
    const result = buf.flush(1);
    expect(result.toString()).toBe("c\n");
  });

  it("tail 1 from data without trailing newline", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("a\nb\nc"));
    const result = buf.flush(1);
    expect(result.toString()).toBe("c");
  });

  it("handles many small single-byte chunks", () => {
    const buf = new TailBuffer();
    const text = "line1\nline2\nline3\n";
    for (const ch of text) {
      buf.push(Buffer.from(ch));
    }
    const result = buf.flush(2);
    expect(result.toString()).toBe("line2\nline3\n");
  });

  it("handles binary data with no newlines", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
    const result = buf.flush(5);
    // No newlines → fewer lines than requested → return everything
    expect(result).toEqual(Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe]));
  });

  it("handles exact line count match", () => {
    const buf = new TailBuffer();
    buf.push(Buffer.from("a\nb\nc\n"));
    // Exactly 3 lines
    const result = buf.flush(3);
    expect(result.toString()).toBe("a\nb\nc\n");
  });
});
