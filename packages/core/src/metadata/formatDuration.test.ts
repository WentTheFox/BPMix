import { describe, expect, it } from 'vitest';
import { formatDuration } from './formatDuration';

describe('formatDuration', () => {
  it('formats under a minute', () => {
    expect(formatDuration(5)).toBe('0:05');
    expect(formatDuration(0)).toBe('0:00');
  });

  it('formats minutes:seconds under an hour', () => {
    expect(formatDuration(65)).toBe('1:05');
    expect(formatDuration(599)).toBe('9:59');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('formats hours:minutes:seconds at or past one hour', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3665)).toBe('1:01:05');
    expect(formatDuration(7325)).toBe('2:02:05');
  });

  it('rounds to the nearest second', () => {
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(59.4)).toBe('0:59');
  });
});
