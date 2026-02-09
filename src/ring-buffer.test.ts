import { describe, it, expect } from "vitest";
import { RingBuffer, DEFAULT_CAPACITY } from "./ring-buffer.js";

describe("RingBuffer", () => {
  it("starts empty", () => {
    const rb = new RingBuffer(64);
    expect(rb.size).toBe(0);
    expect(rb.totalWritten).toBe(0);
    expect(rb.read()).toEqual(Buffer.alloc(0));
  });

  it("rejects non-positive capacity", () => {
    expect(() => new RingBuffer(0)).toThrow("capacity must be positive");
    expect(() => new RingBuffer(-1)).toThrow("capacity must be positive");
  });

  it("default capacity is 1MB", () => {
    expect(DEFAULT_CAPACITY).toBe(1024 * 1024);
  });

  it("writes and reads without wrapping", () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from("hello"));
    expect(rb.size).toBe(5);
    expect(rb.read().toString()).toBe("hello");
  });

  it("accumulates multiple writes", () => {
    const rb = new RingBuffer(64);
    rb.write(Buffer.from("hello "));
    rb.write(Buffer.from("world"));
    expect(rb.size).toBe(11);
    expect(rb.read().toString()).toBe("hello world");
  });

  it("wraps around and overwrites old data", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("ABCDEFGH")); // fills exactly
    expect(rb.size).toBe(8);
    expect(rb.read().toString()).toBe("ABCDEFGH");

    rb.write(Buffer.from("XY")); // overwrites A, B
    expect(rb.size).toBe(8);
    expect(rb.read().toString()).toBe("CDEFGHXY");
  });

  it("handles write larger than capacity", () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from("ABCDEFGH"));
    expect(rb.size).toBe(4);
    expect(rb.read().toString()).toBe("EFGH");
  });

  it("handles write exactly equal to capacity", () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from("ABCD"));
    expect(rb.size).toBe(4);
    expect(rb.read().toString()).toBe("ABCD");
  });

  it("tracks totalWritten across wraps", () => {
    const rb = new RingBuffer(4);
    rb.write(Buffer.from("AB"));
    rb.write(Buffer.from("CDEF"));
    expect(rb.totalWritten).toBe(6);
    expect(rb.size).toBe(4);
  });

  it("handles empty write", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("hi"));
    rb.write(Buffer.from(""));
    expect(rb.size).toBe(2);
    expect(rb.read().toString()).toBe("hi");
  });

  it("clear resets to empty", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("data"));
    rb.clear();
    expect(rb.size).toBe(0);
    expect(rb.totalWritten).toBe(0);
    expect(rb.read()).toEqual(Buffer.alloc(0));
  });

  it("works correctly after clear + new writes", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("ABCDEFGH"));
    rb.clear();
    rb.write(Buffer.from("XY"));
    expect(rb.size).toBe(2);
    expect(rb.read().toString()).toBe("XY");
  });

  it("handles many small writes that wrap multiple times", () => {
    const rb = new RingBuffer(8);
    for (let i = 0; i < 100; i++) {
      rb.write(Buffer.from(String(i % 10)));
    }
    expect(rb.size).toBe(8);
    // Last 8 chars: 92 93 94 95 96 97 98 99 → "23456789"
    expect(rb.read().toString()).toBe("23456789");
  });

  it("handles binary data with NUL bytes", () => {
    const rb = new RingBuffer(8);
    const data = Buffer.from([0x00, 0x01, 0xff, 0x00, 0x42]);
    rb.write(data);
    expect(rb.size).toBe(5);
    expect(rb.read()).toEqual(data);
  });

  it("read returns a copy (not a view)", () => {
    const rb = new RingBuffer(8);
    rb.write(Buffer.from("ABCD"));
    const a = rb.read();
    rb.write(Buffer.from("EFGH"));
    const b = rb.read();
    expect(a.toString()).toBe("ABCD");
    expect(b.toString()).toBe("ABCDEFGH");
  });
});
