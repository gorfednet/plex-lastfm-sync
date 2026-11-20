// Just enough multipart/form-data to read the `payload` field Plex posts.
// Plex may also attach a thumbnail part; it is skipped without being decoded.
const MAX_PART_HEADER = 1024; // a real part header is under 200 bytes

export function boundaryOf(contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? '');
  return m ? (m[1] ?? m[2]) : null;
}

function isPayloadHeader(head) {
  // Line by line, so each match is bounded by one short line.
  return head.split('\r\n').some((line) => /^content-disposition:/i.test(line) && /;\s*name="payload"/i.test(line));
}

export function payloadFromMultipart(body, boundary) {
  const delim = Buffer.from(`--${boundary}`);
  let pos = body.indexOf(delim);
  while (pos !== -1) {
    const start = pos + delim.length;
    if (body.subarray(start, start + 2).toString() === '--') return null; // closing delimiter
    const next = body.indexOf(delim, start);
    if (next === -1) return null;
    const part = body.subarray(start, next);
    const split = part.indexOf('\r\n\r\n');
    if (split !== -1 && split <= MAX_PART_HEADER && isPayloadHeader(part.subarray(0, split).toString('latin1'))) {
      let content = part.subarray(split + 4);
      if (content.subarray(content.length - 2).toString() === '\r\n') content = content.subarray(0, content.length - 2);
      return content.toString('utf8');
    }
    pos = next;
  }
  return null;
}
