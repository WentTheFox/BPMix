import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecodedAudio } from '../audio-engine/types';
import { PreloadScheduler } from './preloadScheduler';

function decodedFor(_fileId: string): DecodedAudio {
  return { sampleRate: 44100, numberOfChannels: 1, channelData: [], durationSeconds: 10 };
}

/** Flushes enough microtasks for a .then().catch().finally() chain on a settled promise to fully run. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}

/** A controllable decode() so tests can resolve/reject specific calls in a specific order. */
class ControllableDecoder {
  calls: string[] = [];
  private pending: Array<{ fileId: string; resolve: (d: DecodedAudio) => void; reject: (e: unknown) => void }> = [];

  decode = (fileId: string): Promise<DecodedAudio> => {
    this.calls.push(fileId);
    return new Promise((resolve, reject) => {
      this.pending.push({ fileId, resolve, reject });
    });
  };

  resolveNext(): void {
    const next = this.pending.shift();
    next?.resolve(decodedFor(next.fileId));
  }

  rejectNext(): void {
    const next = this.pending.shift();
    next?.reject(new Error('decode failed'));
  }
}

describe('PreloadScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not attempt the nearest track until the first retry threshold is crossed', () => {
    const decoder = new ControllableDecoder();
    const scheduler = new PreloadScheduler({ decode: decoder.decode });

    scheduler.tick({ remainingSeconds: 61, upcomingFileIds: ['a'] });
    expect(decoder.calls).toEqual([]);

    scheduler.tick({ remainingSeconds: 60, upcomingFileIds: ['a'] });
    expect(decoder.calls).toEqual(['a']);
  });

  it('retries at each subsequent threshold after a failure, then gives up', async () => {
    const decoder = new ControllableDecoder();
    const onGiveUp = vi.fn();
    const scheduler = new PreloadScheduler({ decode: decoder.decode, onGiveUp });

    scheduler.tick({ remainingSeconds: 60, upcomingFileIds: ['a'] });
    expect(decoder.calls).toEqual(['a']);
    decoder.rejectNext();
    await flush();

    scheduler.tick({ remainingSeconds: 50, upcomingFileIds: ['a'] });
    expect(decoder.calls).toEqual(['a', 'a']);
    decoder.rejectNext();
    await flush();

    scheduler.tick({ remainingSeconds: 40, upcomingFileIds: ['a'] });
    expect(decoder.calls).toEqual(['a', 'a', 'a']);
    decoder.rejectNext();
    await flush();

    scheduler.tick({ remainingSeconds: 35, upcomingFileIds: ['a'] });
    expect(decoder.calls).toEqual(['a', 'a', 'a', 'a']);
    expect(onGiveUp).not.toHaveBeenCalled();
    decoder.rejectNext();
    await flush();

    expect(onGiveUp).toHaveBeenCalledWith('a');

    // No further attempts once given up, even at a later (lower) threshold check.
    scheduler.tick({ remainingSeconds: 10, upcomingFileIds: ['a'] });
    expect(decoder.calls).toEqual(['a', 'a', 'a', 'a']);
  });

  it('makes the decoded buffer available via takePreloaded() once it succeeds', async () => {
    const decoder = new ControllableDecoder();
    const scheduler = new PreloadScheduler({ decode: decoder.decode });

    scheduler.tick({ remainingSeconds: 60, upcomingFileIds: ['a'] });
    expect(scheduler.takePreloaded('a')).toBeUndefined();

    decoder.resolveNext();
    await Promise.resolve();

    expect(scheduler.takePreloaded('a')).toBeDefined();
    // Consumed - a second take is empty.
    expect(scheduler.takePreloaded('a')).toBeUndefined();
  });

  it('does not start a second concurrent decode for a track already in flight', () => {
    const decoder = new ControllableDecoder();
    const scheduler = new PreloadScheduler({ decode: decoder.decode });

    scheduler.tick({ remainingSeconds: 60, upcomingFileIds: ['a'] });
    scheduler.tick({ remainingSeconds: 55, upcomingFileIds: ['a'] });

    expect(decoder.calls).toEqual(['a']);
  });

  it('resets retry progress when a different track takes the nearest slot', async () => {
    const decoder = new ControllableDecoder();
    const scheduler = new PreloadScheduler({ decode: decoder.decode });

    scheduler.tick({ remainingSeconds: 60, upcomingFileIds: ['a'] });
    decoder.rejectNext();
    await flush();

    // A different track becomes nearest (e.g. manual skip) - its own retry
    // sequence starts fresh at the first threshold, not wherever 'a' left off.
    scheduler.tick({ remainingSeconds: 61, upcomingFileIds: ['b'] });
    expect(decoder.calls).toEqual(['a']); // not yet - 61s hasn't crossed the first threshold for 'b'

    scheduler.tick({ remainingSeconds: 60, upcomingFileIds: ['b'] });
    expect(decoder.calls).toEqual(['a', 'b']);
  });

  it('eagerly attempts deeper (non-nearest) slots regardless of remaining time', () => {
    const decoder = new ControllableDecoder();
    const scheduler = new PreloadScheduler({ decode: decoder.decode });

    // Plenty of time left on the current track - nearest slot isn't due yet,
    // but a 2nd-lookahead slot should still start eagerly.
    scheduler.tick({ remainingSeconds: 200, upcomingFileIds: ['a', 'b'] });

    expect(decoder.calls).toEqual(['b']);
  });

  it('retries a failed deep slot after its cooldown, not on every tick', async () => {
    vi.useFakeTimers();
    const decoder = new ControllableDecoder();
    const scheduler = new PreloadScheduler({ decode: decoder.decode });

    scheduler.tick({ remainingSeconds: 200, upcomingFileIds: ['a', 'b'] });
    expect(decoder.calls).toEqual(['b']);
    decoder.rejectNext();
    await vi.advanceTimersByTimeAsync(0);

    scheduler.tick({ remainingSeconds: 200, upcomingFileIds: ['a', 'b'] });
    expect(decoder.calls).toEqual(['b']); // still within cooldown

    await vi.advanceTimersByTimeAsync(6000);
    scheduler.tick({ remainingSeconds: 200, upcomingFileIds: ['a', 'b'] });
    expect(decoder.calls).toEqual(['b', 'b']);
  });

  it('drops preloaded/in-progress state for tracks that fall out of the lookahead window', async () => {
    const decoder = new ControllableDecoder();
    const scheduler = new PreloadScheduler({ decode: decoder.decode });

    scheduler.tick({ remainingSeconds: 200, upcomingFileIds: ['a', 'b'] });
    decoder.resolveNext(); // resolves 'b'
    await Promise.resolve();
    expect(scheduler.takePreloaded('b')).toBeDefined();

    // Re-preload 'b', then it falls out of the window (e.g. user skipped past it).
    scheduler.tick({ remainingSeconds: 200, upcomingFileIds: ['a', 'b'] });
    decoder.resolveNext();
    await Promise.resolve();

    scheduler.tick({ remainingSeconds: 200, upcomingFileIds: ['a', 'c'] });
    expect(scheduler.takePreloaded('b')).toBeUndefined();
  });
});
