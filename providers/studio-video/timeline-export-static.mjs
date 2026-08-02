export function parseByteRange(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const size = Number(fileSize);
  if (!Number.isFinite(size) || size <= 0) return { invalid: true };

  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };

  const [, startText, endText] = match;
  if (!startText && !endText) return { invalid: true };

  let start;
  let end;
  if (!startText) {
    const suffixLength = Number(endText);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) return { invalid: true };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
    if (!Number.isInteger(start) || !Number.isInteger(end)) return { invalid: true };
    if (start < 0 || end < start || start >= size) return { invalid: true };
    end = Math.min(end, size - 1);
  }

  return { start, end };
}

export function staticResponseHeaders({ fileSize, rangeHeader, contentType }) {
  const size = Number(fileSize);
  const baseHeaders = {
    "content-type": contentType || "application/octet-stream",
    "access-control-allow-origin": "*",
    "accept-ranges": "bytes",
  };

  const parsedRange = parseByteRange(rangeHeader, size);
  if (parsedRange?.invalid) {
    return {
      status: 416,
      headers: {
        ...baseHeaders,
        "content-range": `bytes */${size}`,
        "content-length": "0",
      },
      range: null,
    };
  }

  if (parsedRange) {
    return {
      status: 206,
      headers: {
        ...baseHeaders,
        "content-range": `bytes ${parsedRange.start}-${parsedRange.end}/${size}`,
        "content-length": String(parsedRange.end - parsedRange.start + 1),
      },
      range: parsedRange,
    };
  }

  return {
    status: 200,
    headers: {
      ...baseHeaders,
      "content-length": String(size),
    },
    range: null,
  };
}
