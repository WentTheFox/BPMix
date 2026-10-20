import { describe, expect, it } from 'vitest';
import { deriveLastFmStatus } from './connectionStatus';

describe('deriveLastFmStatus', () => {
  it('is connected when a session key is stored and nothing is in flight', () => {
    expect(deriveLastFmStatus('idle', 'sk')).toBe('connected');
  });

  it('is disconnected with no stored session (null, or the empty string a disconnect writes)', () => {
    expect(deriveLastFmStatus('idle', null)).toBe('disconnected');
    expect(deriveLastFmStatus('idle', '')).toBe('disconnected');
  });

  it('follows the stored key as settings hydrate after mount (the restart bug)', () => {
    // First render, before settings load: no key yet.
    expect(deriveLastFmStatus('idle', null)).toBe('disconnected');
    // Same hook instance, after hydration filled it in.
    expect(deriveLastFmStatus('idle', 'sk')).toBe('connected');
  });

  it('shows an attempt in flight regardless of the stored key', () => {
    for (const attempt of ['requestingToken', 'awaitingAuthorization', 'confirming'] as const) {
      expect(deriveLastFmStatus(attempt, null)).toBe(attempt);
      expect(deriveLastFmStatus(attempt, 'sk')).toBe(attempt);
    }
  });
});
