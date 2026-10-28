import { openSync, closeSync, readSync, fstatSync } from "node:fs";

/** Read JSONL without loading a whole native conversation into one JS string. */
export function* jsonlRows(path: string, reverse = false): Generator<Record<string, any>> {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    let offset = reverse ? size : 0;
    let pending = Buffer.alloc(0);
    while (reverse ? offset > 0 : offset < size) {
      const length = Math.min(65536, reverse ? offset : size - offset);
      const position = reverse ? offset - length : offset;
      const chunk = Buffer.alloc(length);
      const got = readSync(fd, chunk, 0, length, position);
      if (!got) break;
      offset = reverse ? position : offset + got;
      pending = reverse ? Buffer.concat([chunk.subarray(0, got), pending]) : Buffer.concat([pending, chunk.subarray(0, got)]);
      let boundary: number;
      while ((boundary = reverse ? pending.lastIndexOf(10) : pending.indexOf(10)) >= 0) {
        const line = reverse ? pending.subarray(boundary + 1) : pending.subarray(0, boundary);
        pending = reverse ? pending.subarray(0, boundary) : pending.subarray(boundary + 1);
        try { const row = JSON.parse(line.toString("utf8")); if (row && typeof row === "object") yield row; } catch { /* incomplete/malformed provider row */ }
      }
    }
    try { const row = JSON.parse(pending.toString("utf8")); if (row && typeof row === "object") yield row; } catch { /* trailing partial row */ }
  } finally { closeSync(fd); }
}
