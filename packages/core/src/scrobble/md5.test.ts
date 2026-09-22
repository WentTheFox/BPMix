import { describe, expect, it } from 'vitest';
import { md5 } from './md5';

describe('md5', () => {
  it('matches known RFC 1321 test vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
  });

  it('handles multi-byte UTF-8 input', () => {
    // Verified against an independent md5 implementation.
    expect(md5('héllo')).toBe('be50e8478cf24ff3595bc7307fb91b50');
  });
});
