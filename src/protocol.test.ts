import { describe, it, expect } from "vitest";
import {
  MSG,
  HEADER_SIZE,
  encodeFrame,
  encodeDataOut,
  encodeDataIn,
  encodeResize,
  encodeExit,
  encodeError,
  encodeHello,
  encodeHelloAck,
  encodeReplayEnd,
  decodeResize,
  decodeExit,
  decodeHello,
  decodeHelloAck,
  decodeError,
  FrameDecoder,
} from "./protocol.js";

describe("protocol constants", () => {
  it("header size is 5 bytes", () => {
    expect(HEADER_SIZE).toBe(5);
  });

  it("message types are unique", () => {
    const values = Object.values(MSG);
    expect(new Set(values).size).toBe(values.length);
  });
});

describe("encodeFrame", () => {
  it("encodes empty payload", () => {
    const frame = encodeFrame(MSG.REPLAY_END);
    expect(frame.length).toBe(5);
    expect(frame[0]).toBe(MSG.REPLAY_END);
    expect(frame.readUInt32BE(1)).toBe(0);
  });

  it("encodes with payload", () => {
    const payload = Buffer.from("hello");
    const frame = encodeFrame(MSG.DATA_OUT, payload);
    expect(frame.length).toBe(5 + 5);
    expect(frame[0]).toBe(MSG.DATA_OUT);
    expect(frame.readUInt32BE(1)).toBe(5);
    expect(frame.subarray(5).toString()).toBe("hello");
  });
});

describe("typed encoders + decoders", () => {
  it("DATA_OUT round-trips through FrameDecoder", () => {
    const data = Buffer.from("terminal output\x1b[31m");
    const frame = encodeDataOut(data);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.type).toBe(MSG.DATA_OUT);
    expect(decoded.payload).toEqual(data);
  });

  it("DATA_IN round-trips", () => {
    const data = Buffer.from("keystrokes");
    const frame = encodeDataIn(data);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.type).toBe(MSG.DATA_IN);
    expect(decoded.payload).toEqual(data);
  });

  it("RESIZE encodes and decodes", () => {
    const frame = encodeResize(120, 40);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.type).toBe(MSG.RESIZE);
    const { cols, rows } = decodeResize(decoded.payload);
    expect(cols).toBe(120);
    expect(rows).toBe(40);
  });

  it("EXIT encodes and decodes positive code", () => {
    const frame = encodeExit(0);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.type).toBe(MSG.EXIT);
    expect(decodeExit(decoded.payload).code).toBe(0);
  });

  it("EXIT encodes and decodes negative code", () => {
    const frame = encodeExit(-1);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decodeExit(decoded.payload).code).toBe(-1);
  });

  it("ERROR encodes and decodes", () => {
    const frame = encodeError("something broke");
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.type).toBe(MSG.ERROR);
    expect(decodeError(decoded.payload)).toBe("something broke");
  });

  it("HELLO encodes and decodes", () => {
    const hello = { mode: "attach" as const, protocolVersion: 1 };
    const frame = encodeHello(hello);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.type).toBe(MSG.HELLO);
    expect(decodeHello(decoded.payload)).toEqual(hello);
  });

  it("HELLO_ACK encodes and decodes", () => {
    const ack = { name: "worker1", cols: 120, rows: 40, mode: "attach" as const, pid: 12345 };
    const frame = encodeHelloAck(ack);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.type).toBe(MSG.HELLO_ACK);
    expect(decodeHelloAck(decoded.payload)).toEqual(ack);
  });

  it("REPLAY_END encodes empty", () => {
    const frame = encodeReplayEnd();
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.type).toBe(MSG.REPLAY_END);
    expect(decoded.payload.length).toBe(0);
  });
});

describe("FrameDecoder", () => {
  it("decodes multiple frames from a single chunk", () => {
    const a = encodeDataOut(Buffer.from("aaa"));
    const b = encodeDataOut(Buffer.from("bbb"));
    const combined = Buffer.concat([a, b]);

    const decoder = new FrameDecoder();
    const frames = decoder.decode(combined);
    expect(frames.length).toBe(2);
    expect(frames[0].payload.toString()).toBe("aaa");
    expect(frames[1].payload.toString()).toBe("bbb");
  });

  it("handles partial header", () => {
    const frame = encodeDataOut(Buffer.from("hello"));
    const decoder = new FrameDecoder();

    // Send only 3 bytes of the 5-byte header
    expect(decoder.decode(Buffer.from(frame.subarray(0, 3)))).toEqual([]);
    // Send the rest
    const frames = decoder.decode(Buffer.from(frame.subarray(3)));
    expect(frames.length).toBe(1);
    expect(frames[0].payload.toString()).toBe("hello");
  });

  it("handles partial payload", () => {
    const frame = encodeDataOut(Buffer.from("hello world"));
    const decoder = new FrameDecoder();

    // Send header + partial payload
    expect(decoder.decode(Buffer.from(frame.subarray(0, 7)))).toEqual([]);
    // Send remaining payload
    const frames = decoder.decode(Buffer.from(frame.subarray(7)));
    expect(frames.length).toBe(1);
    expect(frames[0].payload.toString()).toBe("hello world");
  });

  it("handles byte-at-a-time delivery", () => {
    const frame = encodeDataOut(Buffer.from("AB"));
    const decoder = new FrameDecoder();

    for (let i = 0; i < frame.length - 1; i++) {
      expect(decoder.decode(Buffer.from(frame.subarray(i, i + 1)))).toEqual([]);
    }
    const frames = decoder.decode(Buffer.from(frame.subarray(frame.length - 1)));
    expect(frames.length).toBe(1);
    expect(frames[0].payload.toString()).toBe("AB");
  });

  it("throws on oversized payload", () => {
    const bad = Buffer.alloc(5);
    bad[0] = MSG.DATA_OUT;
    bad.writeUInt32BE(11 * 1024 * 1024, 1); // 11MB
    const decoder = new FrameDecoder();
    expect(() => decoder.decode(bad)).toThrow("Payload too large");
  });

  it("reset clears buffered data", () => {
    const frame = encodeDataOut(Buffer.from("hello"));
    const decoder = new FrameDecoder();
    decoder.decode(Buffer.from(frame.subarray(0, 3))); // partial
    decoder.reset();
    // Now send a full fresh frame
    const frames = decoder.decode(encodeDataOut(Buffer.from("fresh")));
    expect(frames.length).toBe(1);
    expect(frames[0].payload.toString()).toBe("fresh");
  });

  it("handles binary payload with NUL bytes", () => {
    const data = Buffer.from([0x00, 0x1b, 0x5b, 0x33, 0x31, 0x6d, 0x00]);
    const frame = encodeDataOut(data);
    const decoder = new FrameDecoder();
    const [decoded] = decoder.decode(frame);
    expect(decoded.payload).toEqual(data);
  });
});

describe("decode edge cases", () => {
  it("decodeResize rejects short payload", () => {
    expect(() => decodeResize(Buffer.from([0x00]))).toThrow("too short");
  });

  it("decodeExit rejects short payload", () => {
    expect(() => decodeExit(Buffer.from([]))).toThrow("too short");
  });
});
