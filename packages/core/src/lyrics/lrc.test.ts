import { describe, expect, it } from 'vitest';
import { formatLrc, parseLrc } from './lrc';

describe('parseLrc', () => {
  it('parses timestamps and tags, sorted by time', () => {
    const text = ['[ti:Track One]', '[ar:Some Artist]', '[00:12.50]Second line', '[00:00.00]First line'].join('\n');

    expect(parseLrc(text)).toEqual({
      synced: true,
      tags: { ti: 'Track One', ar: 'Some Artist' },
      lines: [
        { timeSeconds: 0, text: 'First line' },
        { timeSeconds: 12.5, text: 'Second line' },
      ],
    });
  });

  it('expands a line with multiple timestamps (repeated chorus) into one entry per timestamp', () => {
    const text = '[00:10.00][00:40.00]Chorus line';
    expect(parseLrc(text)).toEqual({
      synced: true,
      tags: {},
      lines: [
        { timeSeconds: 10, text: 'Chorus line' },
        { timeSeconds: 40, text: 'Chorus line' },
      ],
    });
  });

  it('accepts timestamps with no centiseconds and with 3-digit centiseconds', () => {
    const text = ['[01:02]No centiseconds', '[00:01.500]Three digit centiseconds'].join('\n');
    expect(parseLrc(text)).toEqual({
      synced: true,
      tags: {},
      lines: [
        { timeSeconds: 1.5, text: 'Three digit centiseconds' },
        { timeSeconds: 62, text: 'No centiseconds' },
      ],
    });
  });

  it('falls back to unsynced plain-text lines when no timestamp tag is found', () => {
    const text = ['First line', '', 'Second line', '[Chorus]', 'Third line'].join('\n');
    expect(parseLrc(text)).toEqual({
      synced: false,
      tags: {},
      lines: [
        { timeSeconds: null, text: 'First line' },
        { timeSeconds: null, text: 'Second line' },
        { timeSeconds: null, text: '[Chorus]' },
        { timeSeconds: null, text: 'Third line' },
      ],
    });
  });

  it('handles CRLF line endings and blank lines', () => {
    const text = '[00:00.00]Line one\r\n\r\n[00:05.00]Line two\r\n';
    expect(parseLrc(text)).toEqual({
      synced: true,
      tags: {},
      lines: [
        { timeSeconds: 0, text: 'Line one' },
        { timeSeconds: 5, text: 'Line two' },
      ],
    });
  });
});

describe('formatLrc', () => {
  it('writes tags followed by [mm:ss.xx]text lines', () => {
    const text = formatLrc(
      [
        { timeSeconds: 0, text: 'First line' },
        { timeSeconds: 72.5, text: 'Second line' },
      ],
      { ti: 'Track One' },
    );
    expect(text).toBe('[ti:Track One]\n[00:00.00]First line\n[01:12.50]Second line\n');
  });

  it('writes a null-timeSeconds line as plain unsynced text', () => {
    const text = formatLrc([{ timeSeconds: null, text: 'Not yet timed' }]);
    expect(text).toBe('Not yet timed\n');
  });

  it('round-trips through parseLrc', () => {
    const lines = [
      { timeSeconds: 0, text: 'First line' },
      { timeSeconds: 5.25, text: 'Second line' },
    ];
    expect(parseLrc(formatLrc(lines)).lines).toEqual(lines);
  });
});
