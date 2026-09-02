import type { DecodedAudio } from '../audio-engine/types';

/** Averages all channels down to one - analysis only ever needs a single representative signal, playback stays full-channel. */
export function mixToMono(audio: DecodedAudio): Float32Array {
  if (audio.numberOfChannels === 1) {
    return audio.channelData[0] ?? new Float32Array(0);
  }
  const length = audio.channelData[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const channel of audio.channelData) {
    for (let i = 0; i < length; i++) {
      mono[i] = (mono[i] ?? 0) + (channel[i] ?? 0) / audio.numberOfChannels;
    }
  }
  return mono;
}
