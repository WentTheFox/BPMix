import { describe, expect, it } from 'vitest';
import { hashBytes } from './contentHash';

describe('hashBytes', () => {
  it('is deterministic for the same bytes', () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    expect(hashBytes(bytes)).toBe(hashBytes(new Uint8Array([1, 2, 3, 4, 5])));
  });

  it('differs for different content of the same length', () => {
    expect(hashBytes(new Uint8Array([1, 2, 3]))).not.toBe(hashBytes(new Uint8Array([1, 2, 4])));
  });

  it('differs for the empty vs. non-empty input', () => {
    expect(hashBytes(new Uint8Array())).not.toBe(hashBytes(new Uint8Array([0])));
  });

  it('returns a fixed-width 8-char lowercase hex string', () => {
    expect(hashBytes(new Uint8Array([1, 2, 3]))).toMatch(/^[0-9a-f]{8}$/);
    expect(hashBytes(new Uint8Array())).toMatch(/^[0-9a-f]{8}$/);
  });
});
