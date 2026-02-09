/**
 * Line-based filtering for replay data.
 *
 * Operates on raw bytes, counting \n (0x0A) as line separators.
 * Used by --tail to filter ring buffer replay before writing to stdout.
 */

/**
 * Accumulates replay chunks and flushes the last N lines.
 *
 * Lines are delimited by \n (0x0A). A trailing partial line
 * (no terminating \n) counts as a line.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;

  /**
   * Buffer a replay data chunk.
   */
  push(data: Buffer): void {
    this.chunks.push(data);
    this.totalBytes += data.length;
  }

  /**
   * Return the last `lines` lines from the accumulated data.
   * If the data has fewer than `lines` lines, returns everything.
   * If `lines` is 0, returns empty buffer.
   */
  flush(lines: number): Buffer {
    if (lines === 0 || this.totalBytes === 0) {
      return Buffer.alloc(0);
    }

    // Scan backwards across chunks for \n bytes
    // We need to find the position after which there are `lines` lines.
    // A "line" ends at \n. A trailing chunk without \n counts as 1 line.

    let newlineCount = 0;
    // Whether the last byte of all data is \n (if so, don't count it as starting a line)
    const lastChunk = this.chunks[this.chunks.length - 1];
    const endsWithNewline = lastChunk.length > 0 && lastChunk[lastChunk.length - 1] === 0x0a;

    // Scan backwards
    for (let ci = this.chunks.length - 1; ci >= 0; ci--) {
      const chunk = this.chunks[ci];
      for (let bi = chunk.length - 1; bi >= 0; bi--) {
        if (chunk[bi] === 0x0a) {
          // Skip the very last \n in the entire stream — it terminates the last line,
          // it doesn't start a new one
          if (ci === this.chunks.length - 1 && bi === chunk.length - 1 && endsWithNewline) {
            continue;
          }
          newlineCount++;
          if (newlineCount === lines) {
            // Cut point: everything after this \n is our output
            return this.sliceFrom(ci, bi + 1);
          }
        }
      }
    }

    // Fewer than N lines — return everything
    return Buffer.concat(this.chunks);
  }

  /**
   * Extract data from chunk[ci][bi] to end.
   */
  private sliceFrom(chunkIndex: number, byteIndex: number): Buffer {
    const parts: Buffer[] = [];

    // Partial first chunk
    const first = this.chunks[chunkIndex];
    if (byteIndex < first.length) {
      parts.push(first.subarray(byteIndex));
    }

    // Remaining full chunks
    for (let i = chunkIndex + 1; i < this.chunks.length; i++) {
      parts.push(this.chunks[i]);
    }

    if (parts.length === 0) return Buffer.alloc(0);
    if (parts.length === 1) return parts[0];
    return Buffer.concat(parts);
  }
}
