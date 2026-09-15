/**
 * Audio duration without a full decode - ID3/MP4/FLAC tag *metadata*
 * doesn't reliably carry this (ID3v2's TLEN frame is optional and rarely
 * set by real encoders), so this reads each container format's own
 * structural header instead: FLAC's STREAMINFO and MP4's mvhd give an
 * exact sample count/timescale; MP3 either has a Xing/VBRI frame-count
 * header (most real-world VBR rips do, from LAME/etc.) or falls back to
 * a bitrate-based estimate from the first frame plus the file's total
 * size. Deliberately NOT a full decode (see ensureTrackMetadata's own
 * doc on why avoiding that matters) - every parser here only reads
 * `prefix`, a bounded byte range from the START of the file (see
 * DURATION_PREFIX_BYTES), never the whole thing. A format whose duration
 * genuinely isn't derivable from a prefix (MP4 with its `moov` box placed
 * at the end - an un-"faststart"-optimized file) returns null rather than
 * reading further.
 */

/** How much of the file's start `parseDurationSeconds` ever looks at - generous enough for a large ID3v2 tag (embedded cover art can run to hundreds of KB) plus whatever container header follows it, while still being a small fraction of a real audio file. */
export const DURATION_PREFIX_BYTES = 512 * 1024;

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0;
}

function readUint32LE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset + 3]! << 24) | (bytes[offset + 2]! << 16) | (bytes[offset + 1]! << 8) | bytes[offset]!) >>> 0;
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------
// FLAC - "fLaC" then a METADATA_BLOCK_STREAMINFO (34 bytes, right after
// a 4-byte block header) with sample rate (20 bits) and total sample
// count (36 bits) packed into one 64-bit big-endian span. Always near the
// very start of the file, well within any reasonable prefix.
// ---------------------------------------------------------------------
function parseFlacDuration(bytes: Uint8Array): number | null {
  if (!matchesAscii(bytes, 0, 'fLaC') || bytes.length < 8 + 18) return null;
  // Block header: byte 4 = (last-block flag << 7) | block type; type 0 is
  // STREAMINFO, which the FLAC spec requires to be the very first block.
  const blockType = bytes[4]! & 0x7f;
  if (blockType !== 0) return null;
  // The 8-byte span at offset 18 (8 [fLaC + block header] + 10 [min/max
  // block size + min/max frame size]) holds sampleRate(20) | channels-1(3)
  // | bitsPerSample-1(5) | totalSamples(36) = 64 bits exactly.
  let packed = 0n;
  for (let i = 0; i < 8; i++) {
    packed = (packed << 8n) | BigInt(bytes[18 + i]!);
  }
  const sampleRate = Number((packed >> 44n) & 0xfffffn);
  const totalSamples = Number(packed & 0xfffffffffn);
  if (sampleRate === 0) return null;
  return totalSamples / sampleRate;
}

// ---------------------------------------------------------------------
// WAV - a RIFF/WAVE container of flat chunks; "fmt " gives the byte rate,
// "data" gives the payload size. Both chunks are conventionally early in
// the file (well before any audio payload), so a bounded prefix scan is
// safe - unlike MP4's moov, there's no real-world case of them being
// pushed to the end.
// ---------------------------------------------------------------------
function parseWavDuration(bytes: Uint8Array): number | null {
  if (!matchesAscii(bytes, 0, 'RIFF') || !matchesAscii(bytes, 8, 'WAVE')) return null;
  let offset = 12;
  let byteRate: number | null = null;
  let dataSize: number | null = null;
  while (offset + 8 <= bytes.length && (byteRate === null || dataSize === null)) {
    const chunkId = String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
    const chunkSize = readUint32LE(bytes, offset + 4);
    if (chunkId === 'fmt ' && offset + 8 + 16 <= bytes.length) {
      byteRate = readUint32LE(bytes, offset + 8 + 8);
    } else if (chunkId === 'data') {
      dataSize = chunkSize;
    }
    offset += 8 + chunkSize + (chunkSize % 2); // chunks are word-aligned - an odd size has a padding byte
  }
  if (!byteRate || dataSize === null) return null;
  return dataSize / byteRate;
}

// ---------------------------------------------------------------------
// MP4/M4A/AAC (ISO base media format) - a tree of size-prefixed boxes;
// duration lives in "moov" > "mvhd". moov is conventionally near the
// start for a properly "faststart"-optimized file (the common case for
// anything distributed for streaming/playback), but a file muxed with
// moov trailing after a large mdat (some camera/recording software) has
// its duration outside any reasonable prefix - returns null there rather
// than reading further, same policy as everywhere else in this module.
// ---------------------------------------------------------------------
function findMp4Box(bytes: Uint8Array, type: string, start: number, end: number): { start: number; end: number } | null {
  let offset = start;
  while (offset + 8 <= end) {
    let size = readUint32BE(bytes, offset);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit extended size, stored right after the 4-byte type - a real
      // file this large has no business being duration-derived from a
      // bounded prefix anyway, so this just needs to skip it correctly.
      if (offset + 16 > end) return null;
      const high = readUint32BE(bytes, offset + 8);
      const low = readUint32BE(bytes, offset + 12);
      size = high * 2 ** 32 + low;
      headerSize = 16;
    } else if (size === 0) {
      // "extends to end of file" - unbounded, nothing more to scan usefully.
      size = end - offset;
    }
    const boxType = String.fromCharCode(bytes[offset + 4]!, bytes[offset + 5]!, bytes[offset + 6]!, bytes[offset + 7]!);
    if (boxType === type) {
      return { start: offset + headerSize, end: Math.min(offset + size, end) };
    }
    if (size < headerSize) return null; // malformed - bail rather than loop forever
    offset += size;
  }
  return null;
}

function parseMp4Duration(bytes: Uint8Array): number | null {
  const moov = findMp4Box(bytes, 'moov', 0, bytes.length);
  if (!moov) return null;
  const mvhd = findMp4Box(bytes, 'mvhd', moov.start, moov.end);
  if (!mvhd || mvhd.end - mvhd.start < 4) return null;
  const version = bytes[mvhd.start]!;
  if (version === 1) {
    if (mvhd.end - mvhd.start < 4 + 8 + 8 + 4 + 8) return null;
    const timescaleOffset = mvhd.start + 4 + 8 + 8;
    const timescale = readUint32BE(bytes, timescaleOffset);
    const durHigh = readUint32BE(bytes, timescaleOffset + 4);
    const durLow = readUint32BE(bytes, timescaleOffset + 8);
    const duration = durHigh * 2 ** 32 + durLow;
    if (timescale === 0) return null;
    return duration / timescale;
  }
  // version 0: 4 (version+flags) + 4 (creation) + 4 (modification) + 4 (timescale) + 4 (duration), all 32-bit
  if (mvhd.end - mvhd.start < 4 + 4 + 4 + 4 + 4) return null;
  const timescaleOffset = mvhd.start + 4 + 4 + 4;
  const timescale = readUint32BE(bytes, timescaleOffset);
  const duration = readUint32BE(bytes, timescaleOffset + 4);
  if (timescale === 0) return null;
  return duration / timescale;
}

// ---------------------------------------------------------------------
// MP3 - skip any leading ID3v2 tag, find the first valid MPEG audio frame
// sync, and either read a Xing/Info (LAME and most other VBR encoders) or
// VBRI (Fraunhofer) header for an exact frame count, or fall back to a
// bitrate-based estimate from that one frame's header plus the file's
// total size (accurate for CBR, a reasonable approximation otherwise -
// there's no way to do better without scanning every frame, which would
// mean reading the whole file).
// ---------------------------------------------------------------------
const MPEG_SAMPLE_RATES: Record<number, number[]> = {
  // [MPEG2.5, reserved, MPEG2, MPEG1][index] - id3-frame-header versionBits order
  0b00: [11025, 12000, 8000, 0], // MPEG2.5
  0b10: [22050, 24000, 16000, 0], // MPEG2
  0b11: [44100, 48000, 32000, 0], // MPEG1
};
// Index [layer][bitrateIndex] in kbps, layer: 1=Layer3, 2=Layer2, 3=Layer1 (frame header numbering). MPEG1 table.
const BITRATE_V1: Record<number, number[]> = {
  3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], // Layer1
  2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], // Layer2
  1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // Layer3
};
// MPEG2/2.5 bitrate table - same for Layer2/Layer3, Layer1 differs, but Layer1 is vanishingly rare for music files, so it's omitted (falls through to null).
const BITRATE_V2: Record<number, number[]> = {
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

function id3v2TagSize(bytes: Uint8Array): number {
  if (!matchesAscii(bytes, 0, 'ID3') || bytes.length < 10) return 0;
  // Synchsafe: 4 bytes, only the low 7 bits of each are significant.
  const size = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
  return 10 + size;
}

/** The first valid-looking MPEG audio frame header at or after `from`, or null if none is found within `bytes`. */
function findMp3FrameHeader(
  bytes: Uint8Array,
  from: number,
): { offset: number; mpegVersionBits: number; layerBits: number; bitrateKbps: number; sampleRate: number; padding: number; channelModeBits: number } | null {
  for (let offset = from; offset + 4 <= bytes.length; offset++) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1]! & 0xe0) !== 0xe0) continue;
    const b1 = bytes[offset + 1]!;
    const b2 = bytes[offset + 2]!;
    const b3 = bytes[offset + 3]!;
    const mpegVersionBits = (b1 >> 3) & 0b11;
    const layerBits = (b1 >> 1) & 0b11;
    if (mpegVersionBits === 0b01 || layerBits === 0b00) continue; // reserved version/layer
    const bitrateIndex = (b2 >> 4) & 0x0f;
    const sampleRateIndex = (b2 >> 2) & 0x03;
    if (bitrateIndex === 0 || bitrateIndex === 0x0f || sampleRateIndex === 3) continue; // free/bad bitrate, reserved sample rate
    const sampleRate = MPEG_SAMPLE_RATES[mpegVersionBits]?.[sampleRateIndex];
    if (!sampleRate) continue;
    const bitrateTable = mpegVersionBits === 0b11 ? BITRATE_V1[layerBits] : BITRATE_V2[layerBits];
    const bitrateKbps = bitrateTable?.[bitrateIndex];
    if (!bitrateKbps) continue;
    const padding = (b2 >> 1) & 0x01;
    const channelModeBits = (b3 >> 6) & 0x03;
    return { offset, mpegVersionBits, layerBits, bitrateKbps, sampleRate, padding, channelModeBits };
  }
  return null;
}

function samplesPerFrame(mpegVersionBits: number, layerBits: number): number {
  const isMpeg1 = mpegVersionBits === 0b11;
  if (layerBits === 0b11) return 384; // Layer1
  if (layerBits === 0b10) return 1152; // Layer2
  return isMpeg1 ? 1152 : 576; // Layer3
}

function parseMp3Duration(bytes: Uint8Array, totalSizeBytes: number): number | null {
  const tagSize = id3v2TagSize(bytes);
  const frame = findMp3FrameHeader(bytes, tagSize);
  if (!frame) return null;

  const isMpeg1 = frame.mpegVersionBits === 0b11;
  const isMono = frame.channelModeBits === 0b11;
  // Xing/Info sits after the side-info block, whose size depends on MPEG version and channel mode.
  const xingOffset = frame.offset + 4 + (isMpeg1 ? (isMono ? 17 : 32) : isMono ? 9 : 17);
  if ((matchesAscii(bytes, xingOffset, 'Xing') || matchesAscii(bytes, xingOffset, 'Info')) && xingOffset + 8 <= bytes.length) {
    const flags = readUint32BE(bytes, xingOffset + 4);
    if (flags & 0x1) {
      // "frames" field present, right after the 8-byte tag+flags.
      const frameCount = readUint32BE(bytes, xingOffset + 8);
      const spf = samplesPerFrame(frame.mpegVersionBits, frame.layerBits);
      return (frameCount * spf) / frame.sampleRate;
    }
  }
  // VBRI (Fraunhofer encoder) - always exactly 32 bytes after the frame's own 4-byte header, regardless of side-info size.
  const vbriOffset = frame.offset + 4 + 32;
  if (matchesAscii(bytes, vbriOffset, 'VBRI') && vbriOffset + 26 <= bytes.length) {
    const frameCount = readUint32BE(bytes, vbriOffset + 14);
    const spf = samplesPerFrame(frame.mpegVersionBits, frame.layerBits);
    return (frameCount * spf) / frame.sampleRate;
  }
  // No VBR header - assume CBR and estimate from this frame's bitrate
  // against the audio payload size (total file size minus any ID3v2
  // header). ID3v1/APEv2 footers (128/32 bytes) are a rounding error
  // against a real audio file's size, so they're not worth accounting for.
  const audioBytes = totalSizeBytes - tagSize;
  if (audioBytes <= 0) return null;
  return (audioBytes * 8) / (frame.bitrateKbps * 1000);
}

/**
 * Dispatches to the right container parser by file extension. `prefix`
 * should be up to DURATION_PREFIX_BYTES from the START of the file;
 * `totalSizeBytes` is the file's real full size (used only by MP3's
 * bitrate-estimate fallback). Returns null for an unrecognized extension,
 * a format not covered here (OGG/Opus/WMA - their duration lives at the
 * END of the file, not derivable from a prefix without a much larger
 * read), or a file this couldn't confidently parse.
 */
export function parseDurationSeconds(prefix: Uint8Array, fileName: string, totalSizeBytes: number): number | null {
  try {
    switch (extOf(fileName)) {
      case 'flac':
        return parseFlacDuration(prefix);
      case 'wav':
        return parseWavDuration(prefix);
      case 'm4a':
      case 'mp4':
      case 'aac':
        return parseMp4Duration(prefix);
      case 'mp3':
        return parseMp3Duration(prefix, totalSizeBytes);
      default:
        return null;
    }
  } catch {
    // A truncated/malformed prefix (or a genuinely corrupt file) throwing
    // mid-parse is "duration unknown", not a scan failure.
    return null;
  }
}
