# holdpty — Wire Protocol

Binary length-prefixed frames over Unix domain sockets.

## Frame Format

```
┌──────────┬────────────────────┬─────────────────┐
│ Type     │ Length             │ Payload          │
│ 1 byte   │ 4 bytes (BE u32)  │ <length> bytes   │
└──────────┴────────────────────┴─────────────────┘
```

All multi-byte integers are big-endian.

## Message Types

| Code | Name | Direction | Payload |
|------|------|-----------|---------|
| `0x01` | `DATA_OUT` | holder → client | Raw PTY output bytes |
| `0x02` | `DATA_IN` | client → holder | Keyboard input bytes |
| `0x03` | `RESIZE` | client → holder | `{cols: u16, rows: u16}` — 4 bytes |
| `0x04` | `EXIT` | holder → client | `{code: i32}` — 4 bytes |
| `0x05` | `ERROR` | holder → client | UTF-8 error message |
| `0x06` | `HELLO` | client → holder | JSON (see below) |
| `0x07` | `HELLO_ACK` | holder → client | JSON (see below) |
| `0x08` | `REPLAY_END` | holder → client | Empty (0 bytes) |

## Connection Handshake

1. Client connects to Unix domain socket
2. Client sends `HELLO`:
   ```json
   {
     "mode": "attach" | "view" | "logs" | "wait",
     "protocolVersion": 1
   }
   ```
3. Holder validates:
   - If `mode: "attach"` and a writer is already connected → send `ERROR` ("session already attached") and close
   - If protocol version unsupported → send `ERROR` and close
4. Holder sends `HELLO_ACK`:
   ```json
   {
     "name": "worker1",
     "cols": 120,
     "rows": 40,
     "mode": "attach" | "view" | "logs" | "wait",
     "pid": 12345
   }
   ```
5. Holder replays ring buffer as `DATA_OUT` frames (skipped for `wait` mode)
6. Holder sends `REPLAY_END`
7. For `logs` mode: holder closes connection after `REPLAY_END`
8. For `attach`/`view`: bidirectional streaming begins
9. For `wait`: holder keeps connection open until child exits, then sends `EXIT`

## Data Flow

### attach mode (read-write)
```
Client                          Holder
  │                               │
  │──── HELLO {mode:"attach"} ───►│
  │◄─── HELLO_ACK ───────────────│
  │◄─── DATA_OUT (replay) ───────│  (ring buffer contents)
  │◄─── DATA_OUT (replay) ───────│
  │◄─── REPLAY_END ──────────────│
  │                               │
  │◄─── DATA_OUT (live) ─────────│  (bidirectional)
  │──── DATA_IN ─────────────────►│
  │──── RESIZE ──────────────────►│
  │◄─── DATA_OUT (live) ─────────│
  │                               │
  │◄─── EXIT {code: 0} ──────────│  (child exited)
  │         [connection closes]    │
```

### view mode (read-only)
Same as attach but client never sends `DATA_IN` or `RESIZE`. Holder ignores any such frames if received.

### logs mode (dump and exit)
```
Client                          Holder
  │                               │
  │──── HELLO {mode:"logs"} ─────►│
  │◄─── HELLO_ACK ───────────────│
  │◄─── DATA_OUT (replay) ───────│
  │◄─── REPLAY_END ──────────────│
  │         [connection closes]    │
```

### wait mode (exit code only)
```
Client                          Holder
  │                               │
  │──── HELLO {mode:"wait"} ─────►│
  │◄─── HELLO_ACK ───────────────│
  │◄─── REPLAY_END ──────────────│  (no buffer replay)
  │                               │
  │         [waiting...]           │
  │                               │
  │◄─── EXIT {code: 0} ──────────│  (child exited)
  │         [connection closes]    │
```

Use `wait` mode when you need the child's exit code without consuming PTY output. No `DATA_OUT` frames are sent to wait clients. If the child has already exited when the client connects, `EXIT` is sent immediately after `REPLAY_END`.

## Error Handling

- Unknown message type → skip using length field (forward-compatible)
- Connection drop (socket close/error) → holder marks session as unattached if it was the writer
- Malformed frame (length > 10MB) → close connection
- HELLO with unsupported version → ERROR + close

## Design Rationale

**Why binary, not JSON-lines?** Terminal output contains arbitrary bytes (NUL, newlines, partial UTF-8). JSON encoding requires base64, doubling bandwidth. Binary framing is zero-overhead.

**Why not escape-based framing?** Terminal output is full of escape sequences. Any escape byte we choose would need constant byte-stuffing. Length-prefix avoids this entirely.

**Why single stream, not two channels?** Only ~5 control message types vs. constant data. Separate channels add complexity (two sockets, connection coordination) for no benefit.

**Why 4-byte length?** Supports frames up to 4GB, more than enough. 2-byte (64KB) would require fragmenting large buffer replays.
