import { describe, expect, it } from 'vitest';
import { checkApiCompatibility, parseServerApiVersions } from './compatibility';

describe('parseServerApiVersions', () => {
  it('reads a comma-separated list', () => {
    expect(parseServerApiVersions('1')).toEqual([1]);
    expect(parseServerApiVersions('1, 2')).toEqual([1, 2]);
  });

  it('treats a missing or unreadable header as the original version 1 (servers from before the header existed)', () => {
    expect(parseServerApiVersions(null)).toEqual([1]);
    expect(parseServerApiVersions('')).toEqual([1]);
    expect(parseServerApiVersions('banana')).toEqual([1]);
  });
});

describe('checkApiCompatibility', () => {
  it('accepts a server that speaks the app\'s version, even alongside others', () => {
    expect(checkApiCompatibility(1, [1])).toEqual({ compatible: true });
    expect(checkApiCompatibility(1, [1, 2])).toEqual({ compatible: true });
    expect(checkApiCompatibility(2, [1, 2])).toEqual({ compatible: true });
  });

  it('says the app must update when the server has moved past it', () => {
    const result = checkApiCompatibility(1, [2]);
    expect(result).toMatchObject({ compatible: false, problem: 'app_too_old' });
    expect(result.compatible === false && result.message).toMatch(/newer version of the app/);
  });

  it('says the server must update when the app is newer than it', () => {
    const result = checkApiCompatibility(3, [1, 2]);
    expect(result).toMatchObject({ compatible: false, problem: 'server_too_old' });
    expect(result.compatible === false && result.message).toMatch(/Update the server/);
  });
});
