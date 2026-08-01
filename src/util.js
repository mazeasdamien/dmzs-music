/** Pure functions, with no dependency on the Workers runtime, so they stay testable. */

/** Extracts a video id from just about any URL shape. */
export function videoIdFrom(input) {
  if (!input || typeof input !== "string") return null;
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed;
  const m = trimmed.match(
    /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([\w-]{11})/
  );
  return m ? m[1] : null;
}

/**
 * Parses a Range header. Returns {start, end}, or null if unsatisfiable.
 *
 * Pulled out so it can be tested on its own: this is the piece that silently
 * breaks audio playback on iPhone when it is wrong. Safari probes every
 * <audio> with "Range: bytes=0-1" before reading anything at all.
 */
export function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || "").trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;

  let start;
  let end;
  if (m[1] === "") {
    // Suffix form: "bytes=-500" means the last 500 bytes.
    const n = parseInt(m[2], 10);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === "" ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    return null;
  }
  return { start, end };
}
