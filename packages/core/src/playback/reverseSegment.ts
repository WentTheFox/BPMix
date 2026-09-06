import type { DecodedAudio } from '../audio-engine/types';

/**
 * Extracts [startSeconds, endSeconds) from `decoded` and reverses each
 * channel's sample order - playing the result forward sounds like the
 * original audio played backward across that range. Only the requested
 * range is copied/reversed (not the whole track), so the cost scales with
 * how far back a rewind actually goes, not with track length.
 *
 * A pure function (no engine/native dependency) so TrackPlayer.rewindTo()'s
 * segment-building logic is unit-testable without a real AudioEngine.
 */
export function buildReversedSegment(decoded: DecodedAudio, startSeconds: number, endSeconds: number): DecodedAudio {
  const totalFrames = decoded.channelData[0]?.length ?? 0;
  const startFrame = Math.max(0, Math.min(totalFrames, Math.floor(startSeconds * decoded.sampleRate)));
  const endFrame = Math.max(startFrame, Math.min(totalFrames, Math.ceil(endSeconds * decoded.sampleRate)));
  const frameCount = endFrame - startFrame;
  const channelData = decoded.channelData.map((channel) => {
    const reversed = new Float32Array(frameCount);
    for (let i = 0; i < frameCount; i++) {
      reversed[i] = channel[endFrame - 1 - i] ?? 0;
    }
    return reversed;
  });
  return {
    sampleRate: decoded.sampleRate,
    numberOfChannels: decoded.numberOfChannels,
    channelData,
    durationSeconds: frameCount / decoded.sampleRate,
  };
}
