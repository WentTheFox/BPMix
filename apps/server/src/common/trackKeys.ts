import { BadRequestException } from '@nestjs/common';
import { decodeTrackKey } from '@beatseam/api';

/** The file id behind a track/playlist key from a URL, or a 400. A key that decodes to junk (e.g. NUL bytes, which Postgres refuses to store or compare) is refused here rather than failing deeper down. */
export function fileIdFromKey(key: string): string {
  let fileId: string;
  try {
    fileId = decodeTrackKey(key);
  } catch {
    throw new BadRequestException('Malformed track key');
  }
  if (fileId.includes('\u0000') || fileId.includes('�')) throw new BadRequestException('Malformed track key');
  return fileId;
}
