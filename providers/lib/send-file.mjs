// Sending a file's bytes from a provider, so that no one request can stop it.
// Copyright 2026 mvschwarz. Licensed under the Apache License, Version 2.0.
//
// A provider is one process serving every page of its app. A stream error with no listener (a file that can't be read, or one
// removed mid-read) ends that process, and so does a second writeHead after the first was sent. So the file is opened before
// anything is written, and a file that can't be opened gets one plain answer; an error after the headers went out closes that
// response and nothing else.

import fs from "node:fs";

/**
 * The byte range a Range header asks for in a file of `size` bytes: null when it asks for none (send the whole file),
 * { start, end } (inclusive) when it can be served, or "unsatisfiable" (answer 416).
 */
export function byteRange(header, size) {
  const m = String(header || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) {
    // A suffix range: the last N bytes.
    const n = Number(m[2]);
    if (n === 0 || size === 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (!Number.isSafeInteger(start) || start >= size || end < start) return "unsatisfiable";
  return { start, end };
}

/**
 * Send `file` with `headers` (and status 200, or 206 for a range). `range` is a Range header, or omitted for the whole file.
 * Returns once the response is under way; it never throws.
 */
export function sendFile(res, file, headers, range) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch (error) {
    const missing = error?.code === "ENOENT" || error?.code === "ENOTDIR";
    res.writeHead(missing ? 404 : 403, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });
    return res.end(
      JSON.stringify({
        ok: false,
        error: missing ? "That file wasn't found." : "This machine can't read that file.",
      }),
    );
  }
  let size;
  try {
    size = fs.fstatSync(fd).size;
  } catch {
    fs.closeSync(fd);
    res.writeHead(403);
    return res.end();
  }
  const want = range === undefined ? null : byteRange(range, size);
  if (want === "unsatisfiable") {
    fs.closeSync(fd);
    res.writeHead(416, { "content-range": `bytes */${size}` });
    return res.end();
  }
  const stream = want
    ? fs.createReadStream(null, { fd, start: want.start, end: want.end })
    : fs.createReadStream(null, { fd });
  // After the headers are out the only honest thing left is to cut the response short.
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  res.writeHead(
    want ? 206 : 200,
    want
      ? {
          ...headers,
          "content-range": `bytes ${want.start}-${want.end}/${size}`,
          "content-length": want.end - want.start + 1,
        }
      : { ...headers, "content-length": size },
  );
  stream.pipe(res);
}
