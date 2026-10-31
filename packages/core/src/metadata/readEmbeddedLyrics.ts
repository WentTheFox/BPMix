/** How many bytes an ID3v2 tag occupies at the start of `head` (header included), or 0 when there isn't one. */
export function id3v2TagLength(head: Uint8Array): number {
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return 0;
  return 10 + synchsafe(head, 6);
}

function synchsafe(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! & 0x7f) << 21) | ((bytes[at + 1]! & 0x7f) << 14) | ((bytes[at + 2]! & 0x7f) << 7) | (bytes[at + 3]! & 0x7f);
}

function uint32(bytes: Uint8Array, at: number): number {
  return ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
}

function utf16(bytes: Uint8Array, bigEndianDefault: boolean): string {
  let bigEndian = bigEndianDefault;
  let start = 0;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    bigEndian = false;
    start = 2;
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    bigEndian = true;
    start = 2;
  }
  let out = '';
  for (let i = start; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(bigEndian ? (bytes[i]! << 8) | bytes[i + 1]! : (bytes[i + 1]! << 8) | bytes[i]!);
  }
  return out;
}

function utf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    const extra = b >= 0xf0 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : 0;
    let code = extra === 0 ? b : b & (0x3f >> extra);
    for (let k = 1; k <= extra; k++) code = (code << 6) | ((bytes[i + k] ?? 0) & 0x3f);
    out += String.fromCodePoint(code <= 0x10ffff ? code : 0xfffd);
    i += extra + 1;
  }
  return out;
}

/** ID3 text encodings: 0 ISO-8859-1, 1 UTF-16 with BOM, 2 UTF-16BE, 3 UTF-8. */
function decodeText(bytes: Uint8Array, encoding: number): string {
  switch (encoding) {
    case 1:
      return utf16(bytes, false);
    case 2:
      return utf16(bytes, true);
    case 3:
      return utf8(bytes);
    default: {
      let out = '';
      for (const byte of bytes) out += String.fromCharCode(byte);
      return out;
    }
  }
}

/** Where the descriptor's terminator ends, from `from`: one NUL byte, or an aligned NUL pair for the UTF-16 encodings. */
function afterTerminator(bytes: Uint8Array, from: number, encoding: number): number {
  const wide = encoding === 1 || encoding === 2;
  for (let i = from; i < bytes.length; i += wide ? 2 : 1) {
    if (bytes[i] === 0 && (!wide || bytes[i + 1] === 0)) return i + (wide ? 2 : 1);
  }
  return bytes.length;
}

/** Undoes ID3's "unsynchronisation" (every 0xFF 0x00 stands for a lone 0xFF). */
function unsynchronise(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    out.push(bytes[i]!);
    if (bytes[i] === 0xff && bytes[i + 1] === 0) i++;
  }
  return Uint8Array.from(out);
}

/**
 * The unsynchronised lyrics (the USLT frame, "ULT" in ID3v2.2) of the ID3v2 tag at the start of `tag`,
 * or null when it has none or isn't parseable. Plenty of taggers put a whole `.lrc` file in this frame,
 * so the text is handed back as written and left to `parseLrc`. Pass at least `id3v2TagLength(head)`
 * bytes. Synchronised (SYLT) lyrics and tags in other containers (FLAC, MP4) aren't read.
 */
export function readEmbeddedLyrics(tag: Uint8Array): string | null {
  const total = id3v2TagLength(tag);
  if (total === 0) return null;
  const major = tag[3]!;
  if (major < 2 || major > 4) return null;
  const flags = tag[5]!;
  let body = tag.subarray(10, Math.min(total, tag.length));
  if (flags & 0x80 && major < 4) body = unsynchronise(body);
  let at = 0;
  if (flags & 0x40 && major >= 3 && body.length >= 4) at = major === 4 ? synchsafe(body, 0) : 4 + uint32(body, 0);

  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  while (at + headerLength <= body.length && body[at] !== 0) {
    let id = '';
    for (let i = 0; i < idLength; i++) id += String.fromCharCode(body[at + i]!);
    const size = major === 2 ? (body[at + 3]! << 16) | (body[at + 4]! << 8) | body[at + 5]! : major === 4 ? synchsafe(body, at + 4) : uint32(body, at + 4);
    const dataStart = at + headerLength;
    if (size < 0 || dataStart + size > body.length) return null;
    if (id === 'USLT' || id === 'ULT') {
      const data = body.subarray(dataStart, dataStart + size);
      if (data.length < 5) return null;
      const encoding = data[0]!;
      // 1 encoding byte, 3 language bytes, the descriptor, then the lyrics themselves.
      const text = decodeText(data.subarray(afterTerminator(data, 4, encoding)), encoding).replace(/\0+$/, '');
      return text.trim() === '' ? null : text;
    }
    at = dataStart + size;
  }
  return null;
}
